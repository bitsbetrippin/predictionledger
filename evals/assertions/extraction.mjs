/**
 * Prediction Ledger — Promptfoo assertion: score a model's extraction output against the fixture's
 * expected.json (mustExtract / mustNotExtract), restricted to the window that was shown.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Scoring: each mustExtract item present in this window is worth one point if its quote appears
 * verbatim (case-insensitive), with half credit for a paraphrase; each mustNotExtract hit costs a point.
 * Modality checks ("might" must stay "might") and invented deadlines are hard failures.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

export default async function (output, context) {
  const fixture = String(context.vars.fixture);
  const expected = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "transcripts", `${fixture}.expected.json`), "utf8"));
  let parsed;
  try {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const m = /\{[\s\S]*\}/.exec(text);
    parsed = JSON.parse(m ? m[0] : text);
  } catch {
    return { pass: false, score: 0, reason: "Output is not a JSON object." };
  }
  const preds = Array.isArray(parsed.predictions) ? parsed.predictions : [];
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const reasons = [];
  let score = 0;
  let max = 0;
  let hardFail = false;

  // Only expectations whose quote text occurs in the shown window are scored.
  const prompt = context.prompt ? JSON.stringify(context.prompt).toLowerCase() : "";
  const inWindow = (q) => !prompt || prompt.includes(norm(q).slice(0, 40));

  for (const exp of expected.mustExtract ?? []) {
    if (!inWindow(exp.quoteContains)) continue;
    max += 1;
    const hit = preds.find((p) => norm(p.quote).includes(norm(exp.quoteContains)));
    const loose = hit ?? preds.find((p) => norm(p.normalized_statement).includes(norm(exp.quoteContains).split(" ").slice(0, 4).join(" ")));
    if (hit) score += 1;
    else if (loose) { score += 0.5; reasons.push(`${exp.id ?? exp.quoteContains}: found but quote not verbatim`); }
    else reasons.push(`missing: ${exp.id ?? exp.quoteContains}`);
    const p = hit ?? loose;
    if (p && exp.modality && norm(p.modality) !== exp.modality && !norm(p.normalized_statement).includes(exp.modality)) {
      hardFail = true; reasons.push(`${exp.id}: modality "${exp.modality}" was not preserved (got "${p.modality}")`);
    }
    if (p && exp.deadlineBasis === "unresolved" && p.proposed_deadline) {
      hardFail = true; reasons.push(`${exp.id}: model proposed a deadline (${p.proposed_deadline}) for an expression with none`);
    }
  }
  for (const bad of expected.mustNotExtract ?? []) {
    if (!inWindow(bad.quoteContains)) continue;
    if (preds.some((p) => norm(p.quote).includes(norm(bad.quoteContains)))) { score -= 1; reasons.push(`must not extract (${bad.reason}): ${bad.quoteContains}`); }
  }
  if (max === 0) {
    // window with nothing expected: pass only if the model extracted nothing
    const pass = preds.length === 0;
    return { pass, score: pass ? 1 : 0, reason: pass ? "correctly found no predictions" : `expected none, got ${preds.length}` };
  }
  const ratio = Math.max(0, score) / max;
  return { pass: !hardFail && ratio >= 0.8, score: ratio, reason: reasons.length ? reasons.join("; ") : "all expectations met" };
}
