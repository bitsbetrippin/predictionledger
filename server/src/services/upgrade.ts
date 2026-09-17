/**
 * Prediction Ledger — upgrade rehearsal (2.0, OPS-05 / O05): migrate a COPY of a database, compare what was there
 * before and after, and prove that live trading stays disarmed. Never touches the original file.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Used by `npm run upgrade:rehearse -- <path-to-prediction-ledger.db>` (the owner's real 1.9 data) and by the O05
 * test (the authentic 1.9.0 fixture under fixtures/upgrade/). The inventory hashes every row of the legacy tables
 * in a stable order, so "no loss of IDs/history" is a byte-level statement, not a row count.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../db/index.js";
import { runMigrations, type MigrationOptions } from "../db/migrate.js";

/** Tables that exist in a 1.9.0 database; every row of these must survive an upgrade byte for byte. */
export const LEGACY_TABLES = [
  "settings", "jobs", "videos", "transcript_segments", "transcription_chunks", "predictions", "prediction_components", "prediction_revisions", "validation_plans", "prompt_templates",
  "research_runs", "sources", "run_results", "evidence_items", "assessments", "component_assessments", "search_cache", "games", "markets", "market_snapshots", "prediction_market_links", "alerts", "paper_positions", "paper_marks",
] as const;

export interface TableInventory { rows: number; hash: string; ids?: string[] }
export interface Inventory { schemaVersion: number; tables: Record<string, TableInventory> }

/** Stable per-table digest: every row, every column that exists at the time, ordered by rowid. */
export function inventory(db: Database, tables: readonly string[] = LEGACY_TABLES): Inventory {
  const version = db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_migrations")?.v ?? 0;
  const out: Inventory = { schemaVersion: version, tables: {} };
  for (const t of tables) {
    if (!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t)) continue;
    const cols = db.all<{ name: string }>(`PRAGMA table_info("${t}")`).map((c) => c.name);
    const rows = db.all<Record<string, unknown>>(`SELECT rowid AS __rowid, ${cols.map((c) => `"${c}"`).join(", ")} FROM "${t}" ORDER BY rowid`);
    const h = crypto.createHash("sha256");
    for (const r of rows) h.update(JSON.stringify(cols.map((c) => r[c] ?? null))).update("\n");
    const ids = cols.includes("id") ? rows.map((r) => String(r.id)) : undefined;
    out.tables[t] = { rows: rows.length, hash: h.digest("hex"), ids };
  }
  return out;
}

/** Compare two inventories over the legacy tables: any changed row, lost id or lost table is a finding. */
export function compareInventories(before: Inventory, after: Inventory): { ok: boolean; findings: string[] } {
  const findings: string[] = [];
  for (const [t, b] of Object.entries(before.tables)) {
    const a = after.tables[t];
    if (!a) { findings.push(`${t}: table missing after upgrade`); continue; }
    if (a.rows !== b.rows) findings.push(`${t}: ${b.rows} rows before, ${a.rows} after`);
    if (b.ids && a.ids) { const set = new Set(a.ids); const lost = b.ids.filter((id) => !set.has(id)); if (lost.length) findings.push(`${t}: ${lost.length} id(s) lost (e.g. ${lost.slice(0, 3).join(", ")})`); }
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Column-preserving check: an additive migration may add columns (so the full-row hash changes); this verifies that the
 * columns the old schema had still hold the same values, row by row.
 */
export function legacyColumnsUnchanged(before: Database, after: Database, tables: readonly string[] = LEGACY_TABLES): { ok: boolean; findings: string[] } {
  const findings: string[] = [];
  for (const t of tables) {
    if (!before.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t)) continue;
    if (!after.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t)) { findings.push(`${t}: missing after upgrade`); continue; }
    const cols = before.all<{ name: string }>(`PRAGMA table_info("${t}")`).map((c) => c.name);
    const afterCols = new Set(after.all<{ name: string }>(`PRAGMA table_info("${t}")`).map((c) => c.name));
    const missing = cols.filter((c) => !afterCols.has(c));
    if (missing.length) { findings.push(`${t}: columns dropped: ${missing.join(", ")}`); continue; }
    const sel = cols.map((c) => `"${c}"`).join(", ");
    const key = cols.includes("id") ? "id" : "rowid";
    const digest = (db: Database) => { const h = crypto.createHash("sha256"); for (const r of db.all<Record<string, unknown>>(`SELECT ${sel} FROM "${t}" ORDER BY ${key}`)) h.update(JSON.stringify(cols.map((c) => r[c] ?? null))).update("\n"); return h.digest("hex"); };
    if (digest(before) !== digest(after)) findings.push(`${t}: legacy column values differ after upgrade`);
  }
  return { ok: findings.length === 0, findings };
}

export interface RehearsalReport {
  source: string;
  workDir: string;
  before: Inventory;
  after: Inventory;
  migrationsApplied: number[];
  preMigrationBackup?: string;
  preMigrationBackupScrubbed?: boolean;
  legacyRows: { ok: boolean; findings: string[] };
  legacyColumns: { ok: boolean; findings: string[] };
  liveDisarmed: boolean;
  usRecords: { accounts: number; usMarkets: number; liveIntents: number };
  ok: boolean;
  log: string[];
}

/**
 * Copy `sourcePath` into `workDir`, migrate the copy (with the pre-migration backup written into `workDir/backups`),
 * and report. `interruptAfter` rehearses a crash mid-upgrade: the run throws after that version and the caller reruns.
 */
export function rehearseUpgrade(o: { sourcePath: string; workDir: string; interruptAfter?: number; log?: (line: string) => void }): RehearsalReport {
  const log: string[] = [];
  const say = (line: string) => { log.push(line); o.log?.(line); };
  fs.mkdirSync(o.workDir, { recursive: true });
  const copy = path.join(o.workDir, "prediction-ledger.db");
  if (!fs.existsSync(copy)) {
    // A consistent copy: the source may be in use (WAL); the SQLite backup API through VACUUM INTO gives a clean file.
    const src = new DatabaseSync(o.sourcePath, { readOnly: true } as never);
    try { src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`); } finally { src.close(); }
    say(`[rehearsal] copied ${o.sourcePath} → ${copy} (${(fs.statSync(copy).size / 1024).toFixed(0)} KB); the original is never modified`);
  }
  // The "before" state is the pristine copy; a rerun after an interrupted upgrade compares against that same snapshot.
  const snapshot = path.join(o.workDir, "before.db");
  if (!fs.existsSync(snapshot)) fs.copyFileSync(copy, snapshot);
  const beforeDb = new Database(snapshot);
  const before = inventory(beforeDb);
  beforeDb.close();
  say(`[rehearsal] before: schema ${before.schemaVersion}, ${Object.values(before.tables).reduce((n, t) => n + t.rows, 0)} rows in ${Object.keys(before.tables).length} legacy tables`);
  const db = new Database(copy);
  const applied: number[] = [];
  const backupDir = path.join(o.workDir, "backups");
  const opts: MigrationOptions = { log: say, afterEach: (v) => { applied.push(v); if (o.interruptAfter !== undefined && v === o.interruptAfter) throw new Error(`rehearsal: interrupted after migration ${v}`); } };
  try {
    runMigrations(db, { databasePath: copy, backupDir }, opts);
  } finally {
    db.close();
  }
  const afterDb = new Database(copy);
  const after = inventory(afterDb);
  const beforeSnap = new Database(snapshot);
  const legacyRows = compareInventories(before, after);
  const legacyColumns = legacyColumnsUnchanged(beforeSnap, afterDb);
  beforeSnap.close();
  const has = (t: string) => !!afterDb.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t);
  const policy = has("trading_policy") ? afterDb.get<{ mode: string; live_authorized_at: string | null; authorized_policy_hash?: string | null }>("SELECT * FROM trading_policy LIMIT 1") : undefined;
  const liveDisarmed = !policy || ((policy.mode === "paper" || policy.mode === "disabled") && !policy.live_authorized_at && !policy.authorized_policy_hash);
  const usRecords = {
    accounts: has("trading_accounts") ? afterDb.get<{ n: number }>("SELECT COUNT(*) AS n FROM trading_accounts")!.n : 0,
    usMarkets: afterDb.get<{ n: number }>("SELECT COUNT(*) AS n FROM markets WHERE provider = 'polymarket_us'")!.n,
    liveIntents: has("trade_intents") ? afterDb.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE mode = 'live'")!.n : 0,
  };
  const versions = afterDb.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version);
  const duplicates = versions.length !== new Set(versions).size;
  afterDb.close();
  const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => /-pre-\d{3}\.db$/.test(f)).sort() : [];
  let scrubbed: boolean | undefined;
  if (backups.length) {
    const b = new DatabaseSync(path.join(backupDir, backups[0]), { readOnly: true } as never);
    try {
      const hasT = (t: string) => !!b.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      const secrets = hasT("secrets") ? Number((b.prepare("SELECT COUNT(*) AS n FROM secrets WHERE name LIKE 'trading.%'").get() as { n: number }).n) : 0;
      const armed = hasT("trading_policy") ? Number((b.prepare("SELECT COUNT(*) AS n FROM trading_policy WHERE mode IN ('manual_live','auto_live') OR live_authorized_at IS NOT NULL").get() as { n: number }).n) : 0;
      scrubbed = secrets === 0 && armed === 0;
    } finally { b.close(); }
  }
  const ok = legacyRows.ok && legacyColumns.ok && liveDisarmed && !duplicates && after.schemaVersion > before.schemaVersion;
  say(`[rehearsal] after: schema ${after.schemaVersion}; migrations applied now: ${applied.join(", ") || "none"}; legacy rows ${legacyRows.ok ? "intact" : "CHANGED"}; legacy columns ${legacyColumns.ok ? "intact" : "CHANGED"}; live ${liveDisarmed ? "disarmed" : "ARMED (!)"}; US accounts ${usRecords.accounts}, US markets ${usRecords.usMarkets}, live intents ${usRecords.liveIntents}`);
  return { source: o.sourcePath, workDir: o.workDir, before, after, migrationsApplied: applied, preMigrationBackup: backups[0] ? path.join(backupDir, backups[0]) : undefined, preMigrationBackupScrubbed: scrubbed, legacyRows, legacyColumns, liveDisarmed, usRecords, ok, log };
}

/** Materialise the authentic 1.9.0 fixture (a gzipped SQL dump) as a database file. */
export function restoreSqlDump(dumpPath: string, targetDbPath: string): void {
  const raw = fs.readFileSync(dumpPath);
  const sql = (dumpPath.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8");
  if (fs.existsSync(targetDbPath)) fs.unlinkSync(targetDbPath);
  const db = new DatabaseSync(targetDbPath);
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec(sql);
  } finally {
    db.close();
  }
}
