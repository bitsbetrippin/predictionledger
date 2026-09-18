/**
 * Prediction Ledger — reference-content integrity (2.1): every topic id is unique and namespaced, every `related`
 * and every screen-context id resolves, every hold kind / trading-alert kind / intent state the shared types declare
 * has plain-English help, and the search finds topics by their words.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GROUPS, INTENT_HELP, TOPICS, alertNeedsAction, alertTopic, findTopic, holdTopic, searchTopics } from "./topics";
import { SCREEN_TITLES, SCREEN_TOPICS, screenTopics } from "./context";
import { WORKED_EXAMPLE } from "./workedExample";

const shared = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../shared/src/index.ts"), "utf8");
/** Union members of a `field: "a" | "b"` line inside the named interface, read from the shared source so drift fails here. */
function unionOf(iface: string, field: string): string[] {
  const body = shared.slice(shared.indexOf(`export interface ${iface} {`));
  const m = new RegExp(`\\n\\s*${field}:\\s*([^;]+);`).exec(body.slice(0, body.indexOf("\n}")));
  assert.ok(m, `${iface}.${field} not found in shared/src/index.ts`);
  return [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}
function unionType(name: string): string[] {
  const m = new RegExp(`export type ${name} =([^;]+);`).exec(shared);
  assert.ok(m, `type ${name} not found`);
  return [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

test("topic ids are unique, namespaced by group, and every related id resolves", () => {
  const ids = new Set<string>();
  const groups = new Set(GROUPS.map((g) => g.id));
  for (const t of TOPICS) {
    assert.ok(!ids.has(t.id), `duplicate id ${t.id}`);
    ids.add(t.id);
    assert.ok(groups.has(t.group), `${t.id}: unknown group ${t.group}`);
    assert.ok(t.id.startsWith(`${t.group}.`), `${t.id}: id must start with "${t.group}."`);
    for (const k of ["title", "what", "doing", "next", "source"] as const) assert.ok(t[k].trim().length > 0, `${t.id}: empty ${k}`);
    for (const r of t.related) assert.ok(findTopic(r), `${t.id}: related ${r} does not exist`);
    assert.ok(!t.related.includes(t.id), `${t.id}: relates to itself`);
  }
  assert.equal(TOPICS.length, 38);
});

test("every hold kind, contested settlement, trading-alert kind and intent state has help", () => {
  for (const kind of unionOf("ReconciliationHold", "kind")) assert.ok(holdTopic(kind), `hold kind ${kind} has no topic`);
  assert.equal(holdTopic("discrepancy", "settlement:abc")?.id, "trades.hold.settlement");
  const alertKinds = unionOf("TradingAlert", "kind");
  assert.ok(alertKinds.length >= 10);
  for (const kind of alertKinds) assert.ok(alertTopic(kind), `alert kind ${kind} has no topic`);
  // Action-required alerts are exactly the ones whose hold the owner must resolve.
  assert.deepEqual(alertKinds.filter(alertNeedsAction).sort(), ["discrepancy", "failed_cancel", "stale_sync", "unknown_submission"]);
  for (const state of unionType("IntentState")) assert.ok(INTENT_HELP[state], `intent state ${state} has no one-line help`);
});

test("every screen has titles and resolvable context topics", () => {
  for (const [screen, ids] of Object.entries(SCREEN_TOPICS)) {
    assert.ok(SCREEN_TITLES[screen as keyof typeof SCREEN_TITLES], `${screen}: no title`);
    assert.ok(ids.length > 0, `${screen}: no context topics`);
    for (const id of ids) assert.ok(findTopic(id), `${screen}: context topic ${id} missing`);
    assert.equal(screenTopics(screen as keyof typeof SCREEN_TOPICS).length, ids.length);
  }
});

test("search matches every word and finds holds and alerts by their names", () => {
  assert.ok(searchTopics("discrepancy").some((t) => t.id === "trades.hold.discrepancy"));
  assert.ok(searchTopics("unknown submission").some((t) => t.id === "trades.hold.submission_unknown"));
  assert.ok(searchTopics("deadline pending").some((t) => t.id === "concept.time-status"));
  assert.equal(searchTopics("").length, TOPICS.length);
  assert.equal(searchTopics("zzzz-no-such-word").length, 0);
});

test("the worked example is labelled synthetic, has six steps and never carries a real URL", () => {
  assert.equal(WORKED_EXAMPLE.synthetic, true);
  assert.equal(WORKED_EXAMPLE.steps.length, 6);
  assert.deepEqual(WORKED_EXAMPLE.steps.map((s) => s.id), ["statement", "extraction", "plan", "research", "assessment", "row"]);
  const text = JSON.stringify(WORKED_EXAMPLE);
  assert.ok(!/https?:\/\//.test(text), "no real links in the synthetic example");
  assert.ok(/\.example\b/.test(text), "sources are .example publishers");
});

test("terminology matches the product: time status uses 'Deadline reached', not 'passed'", () => {
  const ts = findTopic("concept.time-status")!;
  assert.ok(ts.what.includes("Deadline reached"));
  assert.ok(!/Deadline passed/.test(JSON.stringify(TOPICS)));
});
