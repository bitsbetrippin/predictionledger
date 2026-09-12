#!/usr/bin/env node
/**
 * Prediction Ledger — copy SQL migrations into the server build output (tsc emits only .ts → .js).
 * Runs as part of `npm run build --workspace server`. Portable (no cp/xcopy).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "server", "src", "db", "migrations");
const dest = path.join(root, "server", "dist", "db", "migrations");
fs.mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  if (f.endsWith(".sql")) {
    fs.copyFileSync(path.join(src, f), path.join(dest, f));
    n++;
  }
}
console.log(`[build] copied ${n} migration file(s) to server/dist/db/migrations`);
