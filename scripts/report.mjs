#!/usr/bin/env node
/**
 * Prediction Ledger — `npm run report:soak` / `npm run report:qualification` (2.0).
 *
 * Renders the paper-soak report (O07) or the strategy/category qualification report (FOR-06/07) from the data directory
 * as markdown (default) or JSON. Read-only: the app can keep running. Nothing here writes a production qualification
 * record — that remains a deliberate owner action once the evidence exists.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Usage: node scripts/report.mjs soak [--from <iso>] [--to <iso>] [--json] [--out <file>]
 *        node scripts/report.mjs qualification [--category sports] [--strategy <version>] [--as-of <iso>] [--json] [--out <file>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "server", "dist");
if (!fs.existsSync(path.join(dist, "context.js"))) {
  console.error("Server is not built yet. Run `npm run build` (or `npm run setup`) first.");
  process.exit(1);
}
const args = process.argv.slice(2);
const kind = args[0];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!["soak", "qualification"].includes(kind)) {
  console.error("Usage: node scripts/report.mjs <soak|qualification> [options]");
  process.exit(1);
}
const { createContext } = await import(path.join(dist, "context.js"));
const ctx = createContext();
try {
  let text;
  if (kind === "soak") {
    const r = ctx.reports.soak({ from: opt("--from"), to: opt("--to") });
    text = args.includes("--json") ? JSON.stringify(r, null, 2) : ctx.reports.soakMarkdown(r);
  } else {
    const r = ctx.reports.qualification({ category: opt("--category"), strategyVersion: opt("--strategy"), asOf: opt("--as-of") });
    text = args.includes("--json") ? JSON.stringify(r, null, 2) : ctx.reports.qualificationMarkdown(r);
  }
  const out = opt("--out");
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, text); console.log(`Report written: ${out}`); }
  else process.stdout.write(text + "\n");
} finally {
  ctx.autoTrader.stop();
  await ctx.jobs.stop();
  ctx.execution.stopStream();
  ctx.db.close();
}
