#!/usr/bin/env node
/**
 * Prediction Ledger — check that the in-app reference (web/src/help/topics.ts) and the repository docs cannot drift:
 * every topic `source` names a file that exists, and its anchor (when present) is a heading slug or an explicit
 * `<a name>` / `id=` anchor in that file. Also checks the worked example's source and that every `related` id exists.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Usage: node scripts/check-help-anchors.mjs   (exit 1 on any missing file or anchor — wired into `npm test`)
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const topicsSrc = readFileSync(join(root, "web/src/help/topics.ts"), "utf8");
const exampleSrc = readFileSync(join(root, "web/src/help/workedExample.ts"), "utf8");

/** GitHub-style heading slug: lowercase, drop punctuation, spaces → hyphens. */
export function slug(heading) {
  return heading.trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N} \-_]/gu, "").replace(/ /g, "-");
}

const cache = new Map();
function anchorsOf(file) {
  if (cache.has(file)) return cache.get(file);
  const text = readFileSync(join(root, file), "utf8");
  const set = new Set();
  const counts = new Map();
  for (const line of text.split("\n")) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const s = slug(h[1]);
      const n = counts.get(s) ?? 0;
      counts.set(s, n + 1);
      set.add(n ? `${s}-${n}` : s);
    }
    for (const m of line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) set.add(m[1]);
    for (const m of line.matchAll(/\sid="([^"]+)"/g)) set.add(m[1]);
  }
  cache.set(file, set);
  return set;
}

const problems = [];
const ids = new Set([...topicsSrc.matchAll(/\bid:\s*"([a-z]+\.[a-z0-9_.\-]+)"/g)].map((m) => m[1]));
const sources = [...topicsSrc.matchAll(/source:\s*"([^"]+)"/g)].map((m) => m[1]);
sources.push(...[...exampleSrc.matchAll(/"source":\s*"([^"]+)"/g)].map((m) => m[1]));
if (ids.size === 0 || sources.length === 0) { console.error("check-help-anchors: could not parse topics.ts"); process.exit(2); }

for (const src of new Set(sources)) {
  const [file, anchor] = src.split("#");
  if (!existsSync(join(root, file))) { problems.push(`${src}: file ${file} does not exist`); continue; }
  if (anchor && !anchorsOf(file).has(anchor)) problems.push(`${src}: no heading or <a name> anchor "${anchor}" in ${file}`);
}
for (const m of topicsSrc.matchAll(/related:\s*\[([^\]]*)\]/g)) {
  for (const r of m[1].matchAll(/"([^"]+)"/g)) if (!ids.has(r[1])) problems.push(`related topic "${r[1]}" does not exist`);
}
// The screen context must only reference topics that exist.
const contextSrc = readFileSync(join(root, "web/src/help/context.ts"), "utf8");
for (const m of contextSrc.matchAll(/"([a-z]+\.[a-z0-9_.\-]+)"/g)) if (!ids.has(m[1])) problems.push(`context topic "${m[1]}" does not exist`);

if (problems.length) {
  console.error(`check-help-anchors: ${problems.length} problem(s)\n  ` + problems.join("\n  "));
  process.exit(1);
}
console.log(`check-help-anchors: ${ids.size} topics, ${new Set(sources).size} sources, every anchor resolves.`);
