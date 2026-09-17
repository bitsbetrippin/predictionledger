#!/usr/bin/env node
/**
 * Prediction Ledger — `npm run upgrade:rehearse -- <path-to-prediction-ledger.db>` (2.0, OPS-05 / O05).
 *
 * Copies the given database into a scratch directory, migrates the COPY to the current schema (writing the usual
 * pre-migration backup beside it), and reports whether every legacy row survived byte for byte and whether live
 * trading is disarmed afterwards. The original file is never modified. Run it against your real 1.9 data before
 * upgrading the application; paste the report into docs/VERIFICATION.md.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Requires `npm run build` (imports server/dist). Options: --interrupt-after <version> simulates a crash after that
 * migration, then reruns (the second run must apply the remainder exactly once). --keep keeps the scratch directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "server", "dist");
if (!fs.existsSync(path.join(dist, "services", "upgrade.js"))) {
  console.error("Server is not built yet. Run `npm run build` (or `npm run setup`) first.");
  process.exit(1);
}
const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--"));
const keep = args.includes("--keep");
const idx = args.indexOf("--interrupt-after");
const interruptAfter = idx >= 0 ? Number(args[idx + 1]) : undefined;
if (!source || !fs.existsSync(source)) {
  console.error("Usage: npm run upgrade:rehearse -- <path-to-prediction-ledger.db> [--interrupt-after <version>] [--keep]");
  console.error("Tip: stop the app first, or point at a backup copy from Setup → Backups.");
  process.exit(1);
}
const { rehearseUpgrade } = await import(path.join(dist, "services", "upgrade.js"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-upgrade-rehearsal-"));
console.log(`Rehearsing an upgrade of ${source} in ${workDir} (the original is not touched)`);
let report;
if (interruptAfter !== undefined) {
  try { rehearseUpgrade({ sourcePath: source, workDir, interruptAfter, log: (l) => console.log(l) }); }
  catch (err) { console.log(`Interrupted on purpose: ${err.message}. Rerunning…`); }
}
report = rehearseUpgrade({ sourcePath: source, workDir, log: (l) => console.log(l) });
const line = (k, v) => console.log(`${k.padEnd(34)} ${v}`);
console.log("");
line("Schema before → after", `${report.before.schemaVersion} → ${report.after.schemaVersion}`);
line("Migrations applied in this run", report.migrationsApplied.join(", ") || "none (already current)");
line("Legacy rows intact", report.legacyRows.ok ? "yes" : `NO — ${report.legacyRows.findings.join("; ")}`);
line("Legacy column values intact", report.legacyColumns.ok ? "yes" : `NO — ${report.legacyColumns.findings.join("; ")}`);
line("Live trading after upgrade", report.liveDisarmed ? "disarmed (paper/disabled, no authorization)" : "ARMED — do not use this build");
line("US records", `${report.usRecords.accounts} account(s), ${report.usRecords.usMarkets} US market(s), ${report.usRecords.liveIntents} live intent(s)`);
line("Pre-migration backup", report.preMigrationBackup ? `${report.preMigrationBackup} (${report.preMigrationBackupScrubbed ? "no trading secrets, not armed" : "CONTAINS TRADING MATERIAL (!)"})` : "none written (nothing was pending)");
for (const [t, b] of Object.entries(report.before.tables)) line(`  ${t}`, `${b.rows} → ${report.after.tables[t]?.rows ?? "missing"}`);
console.log("");
console.log(report.ok ? "RESULT: OK — the upgrade preserves your data and leaves trading disarmed." : "RESULT: FINDINGS — do not upgrade the real data directory until these are understood.");
if (!keep) fs.rmSync(workDir, { recursive: true, force: true }); else console.log(`Scratch directory kept: ${workDir}`);
process.exit(report.ok ? 0 : 2);
