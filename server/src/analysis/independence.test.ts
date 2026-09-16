/**
 * Prediction Ledger — independence groups and "known by" replay tests (1.11, S04/S05 pure parts).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { contentSketch, independenceGroups, knownBy, publisherKey, sketchSimilarity } from "./independence.js";

const WIRE = "The county board voted 5-2 on Tuesday to rescind the conditional use permit for the proposed 300-megawatt data center campus, citing water use and grid capacity. Supporters said the decision would cost the region hundreds of construction jobs, while opponents called it a win for residents.";
const SYNDICATED = `LOCAL NEWS — ${WIRE} Read more from our partners.`;
const INDEPENDENT = "A state review found that two-thirds of large data center applications filed this year were approved on the first vote, according to records obtained by the newspaper, contradicting claims that permits are routinely cancelled.";

test("S04 — same publisher, identical text and near-duplicate text collapse into one group; independent reports stay separate", () => {
  const sources = [
    { id: "a1", url: "https://apnews.com/article/x", publisher: "AP", contentHash: "h1", sketch: contentSketch(WIRE), orderKey: "2026-09-01" },
    { id: "a2", url: "https://www.localpaper.com/wire/x", publisher: "Local Paper", contentHash: "h2", sketch: contentSketch(SYNDICATED), orderKey: "2026-09-02" },
    { id: "b1", url: "https://statejournal.com/review", publisher: "State Journal", contentHash: "h3", sketch: contentSketch(INDEPENDENT), orderKey: "2026-09-03" },
    { id: "b2", url: "https://m.statejournal.com/other", publisher: "State Journal", contentHash: "h4", sketch: contentSketch("An entirely different story about a bridge."), orderKey: "2026-09-04" },
    { id: "c1", url: "https://tribune.example/copy", publisher: "Tribune", contentHash: "h1", sketch: contentSketch(WIRE), orderKey: "2026-09-05" },
  ];
  assert.ok(sketchSimilarity(sources[0].sketch, sources[1].sketch) >= 0.5, "syndicated copy with a local intro is a near-duplicate");
  assert.ok(sketchSimilarity(sources[0].sketch, sources[2].sketch) < 0.2);
  const { groups, reasons } = independenceGroups(sources);
  assert.equal(groups.get("a1"), groups.get("a2"), "wire story and its syndicated copy");
  assert.equal(groups.get("a1"), groups.get("c1"), "identical text on a third domain");
  assert.equal(groups.get("b1"), groups.get("b2"), "same publisher (mobile subdomain stripped)");
  assert.notEqual(groups.get("a1"), groups.get("b1"), "independent report keeps its own group");
  assert.equal(groups.get("a1"), "grp-a1", "labelled after the earliest member");
  assert.match(reasons.get("a2")!.join(";"), /near-duplicate/);
  assert.match(reasons.get("c1")!.join(";"), /identical text/);
  assert.equal(publisherKey("https://amp.example.co.uk/x"), "example.co.uk");
  assert.equal(new Set(groups.values()).size, 2);
});

test("S05 — replay counts only what the app had fetched by the instant; a publication date is an opt-in, labelled assumption", () => {
  const T = "2026-09-10T12:00:00Z";
  // Published "yesterday" but first fetched after the decision: not known at T.
  const late = { publishedAt: "2026-09-09", firstSeenAt: "2026-09-11T08:00:00Z", retrievedAt: "2026-09-11T08:00:00Z" };
  assert.deepEqual(knownBy(late, T), { known: false, basis: "first_seen" });
  assert.deepEqual(knownBy(late, T, { assumePublished: true }), { known: true, basis: "published_assumption" });
  const early = { publishedAt: "2026-09-01", firstSeenAt: "2026-09-05T00:00:00Z", retrievedAt: "2026-09-05T00:00:00Z" };
  assert.deepEqual(knownBy(early, T), { known: true, basis: "first_seen" });
  assert.deepEqual(knownBy({ publishedAt: "2026-09-12" }, T, { assumePublished: true }), { known: false, basis: "unknown" });
  assert.deepEqual(knownBy({}, "not a date"), { known: false, basis: "unknown" });
});
