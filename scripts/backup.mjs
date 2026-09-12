#!/usr/bin/env node
/**
 * Prediction Ledger — `npm run backup`: write a consistent copy of the database (+ secret key) into
 * <data directory>/backups without stopping the app. Same code path as Setup → Backups → "Back up now".
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Requires `npm run build` (imports server/dist). Honours PL_DATA_DIR.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "server", "dist");
if (!fs.existsSync(path.join(dist, "config.js"))) {
  console.error("Server is not built yet. Run `npm run build` (or `npm run setup`) first.");
  process.exit(1);
}
const { resolveDataPaths } = await import(path.join(dist, "config.js"));
const { openDatabase } = await import(path.join(dist, "db", "index.js"));
const { createBackup } = await import(path.join(dist, "services", "backup.js"));

const paths = resolveDataPaths();
if (!fs.existsSync(paths.database)) {
  console.error(`No database found at ${paths.database} — nothing to back up.`);
  process.exit(1);
}
const { db } = openDatabase(paths);
try {
  const info = createBackup(db, paths);
  console.log(`Backup written: ${path.join(paths.backups, info.file)} (${(info.bytes / 1024).toFixed(0)} KB${info.hasSecretKey ? ", secret key copied alongside" : ""})`);
  console.log("Restore: stop Prediction Ledger, copy the .db over prediction-ledger.db (and the .secret.key over secret.key), start again.");
} finally {
  db.close();
}
