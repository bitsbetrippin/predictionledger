/**
 * Prediction Ledger — on-demand database backups (Release 0.6 hardening).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * `VACUUM INTO` writes a consistent, compacted copy of the live database while the app runs —
 * no need to stop it. The secret key file is copied alongside so the backup is self-contained
 * (API keys are AES-256-GCM ciphertext without it). Media/audio files are NOT included; they are
 * content-addressed and can be re-imported. Restore = stop the app, copy the .db (and .secret.key)
 * back over the originals (docs/SETUP.md §5).
 *
 * 1.10 (OPS-02): the copy is a *portable* backup — Polymarket US credentials (`trading.*` secrets) and any
 * live-trading authorization are removed from it before it is written to disk, and the account binding is
 * marked `needs_rebind`. Restoring therefore always requires reconnecting the credential, reconciling and
 * re-arming; an old database can never resume orders on its own. LLM/search keys remain in the copy as
 * before (the secret key file is still copied alongside), so those backups keep their documented sensitivity.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Database } from "../db/index.js";

export interface BackupInfo {
  file: string;
  bytes: number;
  createdAt: string;
  kind: "manual" | "pre-migration";
  hasSecretKey: boolean;
  /** Always false for manual backups since 1.10: trading credentials and live authorization are scrubbed from the copy. */
  tradingCredentialsIncluded?: boolean;
  scrubbed?: { tradingSecrets: number; bindingsMarkedForRebind: number; liveAuthorizationCleared: boolean };
}

/** Remove trading credentials and live authorization from a database *copy* (never from the live database). */
export function scrubTradingFromCopy(copyPath: string): NonNullable<BackupInfo["scrubbed"]> {
  const db = new DatabaseSync(copyPath);
  try {
    const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const tradingSecrets = has("secrets") ? Number(db.prepare("DELETE FROM secrets WHERE name LIKE 'trading.%'").run().changes) : 0;
    let bindings = 0;
    let cleared = false;
    if (has("trading_accounts")) {
      bindings = Number(db.prepare("UPDATE trading_accounts SET state = 'needs_rebind', reconcile_required = 1, last_validation_error = 'portable backup: credentials not included' WHERE state = 'connected'").run().changes);
    }
    if (has("trading_policy")) {
      // 1.14: the automation authorization (policy hash / strategy / category) is part of the armed grant and leaves with it.
      const cols = (db.prepare("PRAGMA table_info(trading_policy)").all() as { name: string }[]).map((c) => c.name);
      const extra = cols.includes("authorized_policy_hash") ? ", authorized_policy_hash = NULL, authorized_strategy_version = NULL, authorized_category = NULL" : "";
      db.prepare(`UPDATE trading_policy SET mode = CASE WHEN mode IN ('manual_live','auto_live') THEN 'paper' ELSE mode END, live_authorized_at = NULL, live_authorization_hash = NULL${extra}`).run();
      cleared = true;
    }
    if (has("trading_audit_events")) {
      db.prepare("INSERT INTO trading_audit_events (id, kind, details_json) VALUES (?, 'backup.scrubbed', ?)").run(
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        JSON.stringify({ tradingSecrets, bindingsMarkedForRebind: bindings, liveAuthorizationCleared: cleared }),
      );
    }
    db.exec("VACUUM");
    return { tradingSecrets, bindingsMarkedForRebind: bindings, liveAuthorizationCleared: cleared };
  } finally {
    db.close();
  }
}

export function createBackup(db: Database, paths: { backups: string; secretKey: string }): BackupInfo {
  fs.mkdirSync(paths.backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = path.join(paths.backups, `manual-${stamp}.db`);
  if (fs.existsSync(target)) fs.rmSync(target);
  // VACUUM INTO takes a string expression; single quotes in the path are doubled per SQL rules.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const scrubbed = scrubTradingFromCopy(target);
  let hasSecretKey = false;
  if (fs.existsSync(paths.secretKey)) {
    fs.copyFileSync(paths.secretKey, `${target.slice(0, -3)}.secret.key`);
    try {
      if (process.platform !== "win32") fs.chmodSync(`${target.slice(0, -3)}.secret.key`, 0o600);
    } catch {
      /* best effort */
    }
    hasSecretKey = true;
  }
  const st = fs.statSync(target);
  return { file: path.basename(target), bytes: st.size, createdAt: st.mtime.toISOString(), kind: "manual", hasSecretKey, tradingCredentialsIncluded: false, scrubbed };
}

export function listBackups(backupsDir: string): BackupInfo[] {
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const st = fs.statSync(path.join(backupsDir, f));
      return { file: f, bytes: st.size, createdAt: st.mtime.toISOString(), kind: f.startsWith("manual-") ? ("manual" as const) : ("pre-migration" as const), hasSecretKey: fs.existsSync(path.join(backupsDir, `${f.slice(0, -3)}.secret.key`)) };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
