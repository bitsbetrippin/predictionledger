/**
 * Prediction Ledger — Promptfoo prompt function: renders the app's real extraction prompt for one
 * fixture window, using the built templates and windowing code (run `npm run build` first).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const dist = path.join(root, "server", "dist");

export default async function ({ vars }) {
  const { parseTranscript } = await import(path.join(dist, "transcripts", "parsers.js"));
  const { buildWindows } = await import(path.join(dist, "analysis", "windowing.js"));
  const { BUILT_IN_TEMPLATES, render } = await import(path.join(dist, "analysis", "prompts.js"));

  const fixture = String(vars.fixture);
  const srt = fs.readFileSync(path.join(root, "fixtures", "transcripts", `${fixture}.srt`), "utf8");
  const expected = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "transcripts", `${fixture}.expected.json`), "utf8"));
  const parsed = parseTranscript(srt, "srt");
  const segments = parsed.segments.map((s, i) => ({ seq: i, startS: s.startS, endS: s.endS, text: s.text, speaker: s.speaker }));
  const windows = buildWindows(segments);
  const w = windows[Number(vars.window ?? 0)];
  if (!w) throw new Error(`fixture ${fixture} has ${windows.length} windows; window ${vars.window} does not exist`);
  const fmt = (s) => new Date(s * 1000).toISOString().slice(11, 19);
  const template = BUILT_IN_TEMPLATES.extraction;
  const user = render(template.user, {
    videoTitle: fixture,
    madeOnDateLine: expected.publishedAt ? `The statements were made on ${expected.publishedAt} (video publication date).` : "The statement date is unknown; do not resolve relative deadlines.",
    windowId: w.id,
    windowRange: `${fmt(w.startS)}–${fmt(w.endS)}`,
    window: w.rendered,
  });
  return [
    { role: "system", content: template.system },
    { role: "user", content: user },
  ];
}
