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
 */

import fs from "node:fs";
import path from "node:path";
import type { Database } from "../db/index.js";

export interface BackupInfo {
  file: string;
  bytes: number;
  createdAt: string;
  kind: "manual" | "pre-migration";
  hasSecretKey: boolean;
}

export function createBackup(db: Database, paths: { backups: string; secretKey: string }): BackupInfo {
  fs.mkdirSync(paths.backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = path.join(paths.backups, `manual-${stamp}.db`);
  if (fs.existsSync(target)) fs.rmSync(target);
  // VACUUM INTO takes a string expression; single quotes in the path are doubled per SQL rules.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
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
  return { file: path.basename(target), bytes: st.size, createdAt: st.mtime.toISOString(), kind: "manual", hasSecretKey };
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
