/**
 * Prediction Ledger — O05: upgrade rehearsal from an authentic v1.9.0 database (2.0, OPS-05), the pre-migration
 * backup scrub (RV-07), interrupted-and-rerun migrations, restore/rebind after the upgrade, and a live drill on the
 * upgraded data (fake venue): interrupted submission → second process → recovery → cutoff.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * The fixture under fixtures/upgrade/ was produced by the released 1.9.0 code (see its header) — it is not a
 * hand-written schema. The owner runs the same rehearsal on the real data directory with `npm run upgrade:rehearse`.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { LIVE_ACKNOWLEDGEMENT } from "../services/tradingAccounts.js";
import { FakeTradingAdapter, fakeBalance } from "../providers/trading/fake.js";
import { setTradingAdapterForTests } from "../providers/trading/registry.js";
import { Database } from "./index.js";
import { runMigrations } from "./migrate.js";
import { compareInventories, inventory, legacyColumnsUnchanged, rehearseUpgrade, restoreSqlDump, LEGACY_TABLES } from "../services/upgrade.js";
import { createBackup, scrubTradingFromCopy } from "../services/backup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "..", "fixtures");
const DUMP = path.join(fixtures, "upgrade", "v1.9.0-authentic.sql.gz");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(fixtures, "upgrade", "v1.9.0-authentic.json"), "utf8")) as { schemaVersion: number; tables: Record<string, number> };

after(() => { delete process.env.PL_DATA_DIR; setTradingAdapterForTests(undefined); });

function scratch(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test("O05 (fixture) — the authentic 1.9.0 database really is schema 11 with every original data type populated", () => {
  const dir = scratch("pl-o05-fixture-");
  const file = path.join(dir, "v19.db");
  restoreSqlDump(DUMP, file);
  const db = new Database(file);
  try {
    const inv = inventory(db);
    assert.equal(inv.schemaVersion, 11);
    assert.deepEqual(db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const t of LEGACY_TABLES) assert.ok((inv.tables[t]?.rows ?? 0) > 0, `${t} is populated in the fixture`);
    for (const [t, n] of Object.entries(MANIFEST.tables)) if (t !== "schema_migrations") assert.equal(inv.tables[t]?.rows ?? db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t}"`)!.n, n, `${t} matches the manifest`);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'trading_%'")!.n, 0, "no trading table exists at 1.9");
    assert.deepEqual(db.all<{ provider: string }>("SELECT DISTINCT provider FROM markets ORDER BY provider").map((r) => r.provider), ["manifold", "polymarket"]);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM secrets")!.n, 0, "the fixture ships no ciphertext");
  } finally { db.close(); }
});

test("O05 — upgrading the 1.9.0 database (interrupted after 013, then rerun) applies every migration exactly once, keeps every legacy row and id byte for byte, isolates US records and leaves live trading disarmed; the pre-migration backup is scrubbed (RV-07)", () => {
  const dir = scratch("pl-o05-");
  const source = path.join(dir, "real-1.9.db");
  restoreSqlDump(DUMP, source);
  const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  const work = path.join(dir, "work");
  // 1. Interrupted upgrade: the process dies after migration 013 (each migration commits in its own transaction).
  assert.throws(() => rehearseUpgrade({ sourcePath: source, workDir: work, interruptAfter: 13 }), /interrupted after migration 13/);
  const mid = new Database(path.join(work, "prediction-ledger.db"));
  assert.deepEqual(mid.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], "012 and 013 committed, 014+ not yet");
  mid.close();
  // 2. Rerun: the remainder applies once; nothing is applied twice.
  const report = rehearseUpgrade({ sourcePath: source, workDir: work });
  assert.equal(report.ok, true, report.log.join("\n"));
  assert.deepEqual(report.migrationsApplied, [14, 15, 16]);
  assert.equal(report.before.schemaVersion, 11);
  assert.equal(report.after.schemaVersion, 16);
  assert.equal(report.legacyRows.ok, true, report.legacyRows.findings.join("; "));
  assert.equal(report.legacyColumns.ok, true, report.legacyColumns.findings.join("; "));
  for (const t of LEGACY_TABLES) assert.equal(report.after.tables[t].rows, report.before.tables[t].rows, t);
  assert.equal(report.liveDisarmed, true);
  assert.deepEqual(report.usRecords, { accounts: 0, usMarkets: 0, liveIntents: 0 }, "the upgrade creates no US record");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex"), sourceHash, "the original file is untouched");
  const db = new Database(path.join(work, "prediction-ledger.db"));
  try {
    const versions = db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version);
    assert.deepEqual(versions, Array.from({ length: 16 }, (_, i) => i + 1));
    // Legacy semantics survive: paper positions keep their original simulation method; settings JSON is unchanged.
    assert.deepEqual(db.all<{ method: string }>("SELECT DISTINCT method FROM paper_positions").map((r) => r.method), ["legacy-snapshot-v1"]);
    assert.equal(db.get<{ mode: string }>("SELECT mode FROM trading_policy")!.mode, "paper");
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM markets WHERE provider IN ('polymarket','manifold')")!.n, report.before.tables.markets.rows, "international and Manifold records are preserved without conversion");
  } finally { db.close(); }
  // 3. RV-07: the pre-migration backup written by the upgrade carries no trading material. Rehearse it on a 15-schema
  //    copy that IS armed and DOES hold a trading secret (what an owner's 1.13/1.14 database looks like).
  const armedDir = path.join(dir, "armed");
  fs.mkdirSync(armedDir, { recursive: true });
  const armedDb = path.join(armedDir, "prediction-ledger.db");
  restoreSqlDump(DUMP, armedDb);
  {
    const d = new Database(armedDb);
    runMigrations(d, undefined, { upTo: 15, log: () => {} });
    d.run("INSERT INTO secrets (name, ciphertext, iv, auth_tag, hint, updated_at) VALUES ('trading.polymarket_us.secret', X'00', X'00', X'00', '…', ?)", new Date().toISOString());
    d.run("UPDATE trading_policy SET mode = 'manual_live', live_authorized_at = ?, live_authorization_hash = 'abc'", new Date().toISOString());
    d.close();
  }
  const armedReport = rehearseUpgrade({ sourcePath: armedDb, workDir: path.join(dir, "armed-work") });
  assert.deepEqual(armedReport.migrationsApplied, [16]);
  assert.ok(armedReport.preMigrationBackup, "a backup was written before 016");
  assert.equal(armedReport.preMigrationBackupScrubbed, true, "the pre-migration backup holds no trading secret and no armed grant");
  assert.equal(armedReport.liveDisarmed, false, "the WORKING copy still says manual_live at this point — the app's startup check (below) disarms it; the rehearsal reports it honestly");
  const b = new DatabaseSync(armedReport.preMigrationBackup!, { readOnly: true } as never);
  try {
    assert.equal((b.prepare("SELECT COUNT(*) AS n FROM secrets WHERE name LIKE 'trading.%'").get() as { n: number }).n, 0);
    assert.equal((b.prepare("SELECT mode, live_authorized_at FROM trading_policy").get() as { mode: string; live_authorized_at: string | null }).mode, "paper");
    assert.equal((b.prepare("SELECT state FROM trading_accounts LIMIT 1").get() as { state: string } | undefined)?.state ?? "none", "none");
  } finally { b.close(); }
});

test("O05 (drill) — on the upgraded data: the app starts disarmed, a fake account connects and arms, a submission interrupted after the marker is recovered by the NEXT start as unknown (never resent), a backup restores as needs-rebind, and a cutoff that passed while stopped places nothing", async () => {
  const dir = scratch("pl-o05-drill-");
  process.env.PL_DATA_DIR = dir;
  restoreSqlDump(DUMP, path.join(dir, "prediction-ledger.db"));
  const before = (() => { const d = new Database(path.join(dir, "prediction-ledger.db")); try { return inventory(d); } finally { d.close(); } })();
  const fake = new FakeTradingAdapter();
  setTradingAdapterForTests(fake);
  const KEY = "11111111-2222-3333-4444-555555555555";
  const SECRET = crypto.randomBytes(32).toString("base64");
  fake.script(KEY, { secretKey: SECRET, balances: [fakeBalance("100.00", "100.00")] });
  let clock = "2026-10-01T12:00:00Z";
  fake.now = () => new Date(Date.parse(clock));
  const { createContext } = await import("../context.js");
  // Start 1: the upgrade runs inside the app's own startup (same code path as `npm start`).
  let ctx = createContext({ now: () => new Date(Date.parse(clock)), leaseHolder: "drill-1" });
  try {
    assert.equal(ctx.db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_migrations")!.v, 16);
    const after1 = inventory(ctx.db);
    for (const t of LEGACY_TABLES) assert.equal(after1.tables[t].rows, before.tables[t].rows, `${t} survives the app's own migration run`);
    assert.equal(ctx.trading.policy().mode, "paper");
    assert.equal(ctx.trading.connected(), undefined);
    // Legacy content is readable through the current services (not just present in the file).
    const videos = ctx.videos.list();
    assert.equal(videos.length, before.tables.videos.rows);
    const withPredictions = videos.find((v) => ctx.predictions.list({ videoId: v.id }).length > 0)!;
    assert.ok(withPredictions, "a 1.9 video with predictions is listed");
    const p = ctx.predictions.list({ videoId: withPredictions.id })[0];
    assert.ok(ctx.predictions.get(p.id)?.quoteExact, "a 1.9 prediction hydrates with its quote");
    assert.ok(ctx.markets.list().length >= before.tables.markets.rows, "1.9 markets list");
    // Connect + arm manual-live on the upgraded database; nothing in the legacy data blocks it.
    await ctx.trading.connect({ keyId: KEY, secretKey: SECRET });
    await ctx.trading.sync();
    assert.ok(ctx.lease.acquire(60_000));
    ctx.trading.setMode("manual_live", { acknowledge: LIVE_ACKNOWLEDGEMENT });
    assert.equal(ctx.trading.status().armed, true);
    // An interrupted submission: an intent with its dispatch marker written but no POST answer (process died after the marker).
    const bindingId = ctx.trading.connected()!.id;
    ctx.db.run("INSERT INTO markets (id, provider, venue_id, slug, url, question, outcomes_json, active, closed, restricted, resolved, tags_json, watched, created_at, updated_at) VALUES ('m-drill', 'polymarket_us', 'aec-drill', 'aec-drill', 'https://polymarket.us/event/drill', 'Drill?', '[]', 1, 0, 0, 0, '[]', 0, ?, ?)", clock, clock);
    ctx.db.run("INSERT INTO trade_decisions (id, created_at, clock_at, mode, prediction_id, market_id, venue_market_id, outcome, currency, budget_timezone, daily_bucket, policy_version, policy_hash, gates_json, reason_codes_json, inputs_json, rationale_hash) VALUES ('d-drill', ?, ?, 'manual_live', ?, 'm-drill', 'aec-drill', 'needs_review', 'USD', 'UTC', '2026-10-01', 1, 'h', '[]', '[]', '{}', 'r')", clock, clock, p.id);
    ctx.db.run("INSERT INTO risk_reservations (id, decision_id, account_key, provider, venue_market_id, amount, daily_bucket, state, created_at, updated_at) VALUES ('res-drill', 'd-drill', ?, 'polymarket_us', 'aec-drill', '9.88', '2026-10-01', 'reserved', ?, ?)", bindingId, clock, clock);
    ctx.db.run("INSERT INTO trade_intents (id, decision_id, reservation_id, mode, account_key, provider, venue_market_id, side, quantity, wire_price, limit_cost, time_in_force, state, payload_hash, created_at, updated_at, binding_id, market_slug, dispatch_marker_at, submitted_at) VALUES ('i-drill', 'd-drill', 'res-drill', 'live', ?, 'polymarket_us', 'aec-drill', 'yes', '19', '0.5', '0.5', 'IOC', 'submitting', 'ph', ?, ?, ?, 'aec-drill', ?, ?)", bindingId, clock, clock, bindingId, clock, clock);
    ctx.db.run("INSERT INTO trade_opportunities (account_key, provider, venue_market_id, intent_id, consumed_at) VALUES (?, 'polymarket_us', 'aec-drill', 'i-drill', ?)", bindingId, clock);
    ctx.lease.release();
  } finally { ctx.db.close(); }
  // Start 2 (the "next start"): disarmed again, recovery marks the interrupted submission unknown — no resend, capacity held.
  clock = "2026-10-01T12:05:00Z";
  ctx = createContext({ now: () => new Date(Date.parse(clock)), leaseHolder: "drill-2" });
  try {
    assert.equal(ctx.trading.policy().mode, "paper", "a restart never resumes a live mode");
    assert.ok(ctx.lease.acquire(60_000));
    const rec = ctx.execution.recoverAfterCrash();
    assert.deepEqual(rec, { expired: [], unknown: ["i-drill"] });
    assert.equal(ctx.execution.intent("i-drill")?.state, "submission_unknown");
    assert.equal(ctx.risk.get("res-drill")?.state, "reserved", "capacity stays held");
    assert.ok(ctx.risk.opportunityConsumed(ctx.trading.connected()!.id, "polymarket_us", "aec-drill"));
    assert.equal(fake.createCalls, 0, "nothing was resent");
    assert.ok(ctx.trading.dispatchBlockers().some((b) => /hold/.test(b)));
    // A backup taken now restores as needs-rebind, disarmed, with the unknown intent still unknown (U05/O02 on upgraded data).
    const backup = createBackup(ctx.db, { backups: path.join(dir, "backups"), secretKey: path.join(dir, "secret.key") });
    assert.equal(backup.tradingCredentialsIncluded, false);
    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-o05-restore-"));
    fs.copyFileSync(path.join(dir, "backups", backup.file), path.join(restoreDir, "prediction-ledger.db"));
    ctx.lease.release();
    ctx.db.close();
    process.env.PL_DATA_DIR = restoreDir;
    const restored = createContext({ now: () => new Date(Date.parse(clock)), leaseHolder: "drill-3" });
    try {
      assert.equal(restored.trading.policy().mode, "paper");
      assert.equal(restored.db.get<{ state: string }>("SELECT state FROM trading_accounts")?.state, "needs_rebind", "restored without its key: rebind required before anything live");
      assert.equal(restored.trading.connected(), undefined);
      assert.equal(restored.execution.intent("i-drill")?.state, "submission_unknown");
      const inv = inventory(restored.db);
      for (const t of LEGACY_TABLES) assert.equal(inv.tables[t].rows, before.tables[t].rows + (t === "markets" ? 1 : 0), `${t} survives backup + restore (markets: + the drill's US market)`);
      assert.equal(fake.createCalls, 0);
    } finally { restored.db.close(); }
    process.env.PL_DATA_DIR = dir;
  } finally { try { ctx.db.close(); } catch { /* already closed before the restore */ } }
  // Cutoff passed while stopped: the scheduler evaluates nothing for an event whose cutoff is behind the clock (no catch-up).
  clock = "2026-10-02T12:00:00Z";
  ctx = createContext({ now: () => new Date(Date.parse(clock)), leaseHolder: "drill-4" });
  try {
    assert.ok(ctx.lease.acquire(60_000));
    const run = await ctx.autoTrader.tick();
    assert.equal(run.outcome, "skipped", "disarmed after restart: the scheduler places nothing");
    assert.equal(run.ordered, 0);
    assert.equal(fake.createCalls, 0);
  } finally { ctx.lease.release(); ctx.db.close(); }
});

test("O05 — a scrub of a 1.9.0 copy (no trading tables) is a no-op that still records nothing sensitive; the inventory helpers detect a lost row", () => {
  const dir = scratch("pl-o05-scrub-");
  const file = path.join(dir, "copy.db");
  restoreSqlDump(DUMP, file);
  const r = scrubTradingFromCopy(file);
  assert.deepEqual(r, { tradingSecrets: 0, bindingsMarkedForRebind: 0, liveAuthorizationCleared: false });
  const a = new Database(file);
  const invA = inventory(a);
  a.run("DELETE FROM predictions WHERE id = (SELECT id FROM predictions LIMIT 1)");
  const invB = inventory(a);
  const cmp = compareInventories(invA, invB);
  assert.equal(cmp.ok, false);
  assert.ok(cmp.findings.some((f) => /^predictions: 64 rows before, 63 after/.test(f)) && cmp.findings.some((f) => /^predictions: 1 id\(s\) lost/.test(f)), cmp.findings.join("; "));
  const b = new Database(file);
  assert.equal(legacyColumnsUnchanged(b, a).ok, true, "same file, same values");
  a.close(); b.close();
});
