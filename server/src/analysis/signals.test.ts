/**
 * Prediction Ledger — tests for signals (1.7): the math with fixtures, and the service over a small ledger.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { clampProb, combineEdges, confidenceLabel, deadlineCheck, outcomeOf, priceNearest, recordStats, shrink, type Gates } from "./signals.js";

const gates: Gates = { priorWeight: 10, minSettledLean: 3, minSettledModerate: 8, minSettledStrong: 20, minLiquidity: 10_000 };

test("recordStats: realized edge, market and creator Brier; a favourites-only caller has ~no edge", () => {
  // Creator A: three calls at 0.40 that all came in → +0.60 per $1.
  const a = recordStats([{ outcome: 1, priceAtMade: 0.4 }, { outcome: 1, priceAtMade: 0.4 }, { outcome: 1, priceAtMade: 0.4 }]);
  assert.equal(a.realizedEdge, 0.6);
  assert.equal(a.marketBrier, 0.36);
  assert.equal(a.creatorBrier, 0);
  // Creator B: twenty calls on 95 % favourites, nineteen hit → 19·0.05 − 0.95 = 0 realized edge.
  const b = recordStats([...Array.from({ length: 19 }, () => ({ outcome: 1 as const, priceAtMade: 0.95 })), { outcome: 0, priceAtMade: 0.95 }]);
  assert.equal(b.realizedEdge, 0);
  assert.equal(b.creatorBrier, 0.05);
  assert.ok(b.marketBrier! < 0.06);
  assert.deepEqual(recordStats([]), { linkedSettled: 0 });
  assert.equal(recordStats([{ outcome: 0.5, priceAtMade: 0.5 }]).realizedEdge, 0);
});

test("shrink, combineEdges, clampProb", () => {
  assert.equal(shrink(0.6, 3, 10), 0.1385);
  assert.equal(shrink(0.6, 30, 10), 0.45);
  assert.equal(shrink(0.6, 3, 0), 0.6);
  assert.equal(shrink(undefined, 3, 10), undefined);
  assert.equal(shrink(0.6, 0, 10), undefined);
  const c = combineEdges([{ sourceKey: "v1", settled: 3, shrunkEdge: 0.1 }, { sourceKey: "v2", settled: 9, shrunkEdge: -0.02 }, { sourceKey: "v1", settled: 3, shrunkEdge: 0.9 }]);
  assert.equal(c.creators, 2, "same video counted once");
  assert.equal(c.weight, 12);
  assert.equal(c.edge, 0.01);
  assert.deepEqual(combineEdges([{ sourceKey: "v", settled: 0 }]), { weight: 0, creators: 1 });
  assert.equal(clampProb(1.2), 0.99);
  assert.equal(clampProb(-0.2), 0.01);
});

test("confidenceLabel: gates on record size, edge size, liquidity, deadline and price", () => {
  const ok = (settled: number, edge: number) => confidenceLabel({ edge, settled, liquidity: 50_000, marketPrice: 0.4, deadlineCheck: "consistent" }, gates);
  assert.equal(ok(25, 0.12).confidence, "strong");
  assert.equal(ok(25, 0.06).confidence, "moderate", "big record, small edge → moderate");
  assert.equal(ok(10, 0.06).confidence, "moderate");
  assert.equal(ok(4, 0.04).confidence, "lean");
  assert.equal(ok(2, 0.5).confidence, "none");
  assert.match(ok(2, 0.5).reasons.join(" "), /record too thin \(2 settled, need 3\)/);
  assert.equal(ok(30, 0.01).confidence, "none");
  assert.match(ok(30, 0.01).reasons.join(" "), /noise band/);
  const thin = confidenceLabel({ edge: 0.2, settled: 25, liquidity: 500, marketPrice: 0.4, deadlineCheck: "consistent" }, gates);
  assert.equal(thin.confidence, "none");
  assert.match(thin.reasons.join(" "), /liquidity 500 below 10,000/);
  assert.equal(confidenceLabel({ edge: 0.2, settled: 25, liquidity: 50_000, marketPrice: 0.4, deadlineCheck: "inconsistent" }, gates).confidence, "none");
  assert.equal(confidenceLabel({ edge: 0.2, settled: 25, liquidity: 50_000, marketPrice: undefined, deadlineCheck: "consistent" }, gates).confidence, "none");
  assert.equal(confidenceLabel({ edge: undefined, settled: 0, liquidity: 50_000, marketPrice: 0.4, deadlineCheck: "consistent" }, gates).confidence, "none");
  assert.equal(confidenceLabel({ edge: 0.2, settled: 25, liquidity: 50_000, marketPrice: 0.4, deadlineCheck: "unknown" }, gates).confidence, "strong", "unknown deadline is reported, not fatal");
});

test("deadlineCheck, outcomeOf, priceNearest", () => {
  assert.equal(deadlineCheck("2026-12-31", "2026-12-31T12:00:00Z"), "consistent");
  assert.equal(deadlineCheck("2026-06-30", "2026-12-31T12:00:00Z"), "inconsistent");
  assert.equal(deadlineCheck(undefined, "2026-12-31"), "unknown");
  assert.equal(outcomeOf("supported"), 1);
  assert.equal(outcomeOf("contradicted"), 0);
  assert.equal(outcomeOf("partially_supported"), 0.5);
  assert.equal(outcomeOf("insufficient"), undefined);
  assert.equal(outcomeOf(undefined), undefined);
  const pts = [{ t: "2026-09-09T08:00:00Z", p: 0.5 }, { t: "2026-09-09T11:00:00Z", p: 0.52 }, { t: "2026-09-09T15:00:00Z", p: 0.6 }];
  assert.equal(priceNearest(pts, "2026-09-09T12:00:00Z")?.p, 0.52, "at or before");
  assert.equal(priceNearest(pts, "2026-09-09T07:00:00Z")?.p, 0.5, "nothing before → nearest");
  assert.equal(priceNearest([], "2026-09-09T12:00:00Z"), undefined);
});

// ---------------------------------------------------------------------------
// Service over a small ledger
// ---------------------------------------------------------------------------

after(() => { delete process.env.PL_DATA_DIR; });

test("SignalService: creator records by channel, signals per market side, gates and contributions", async () => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-signals-"));
  const { createContext } = await import("../context.js");
  const ctx = createContext();
  try {
    const srt = "1\n00:00:00,000 --> 00:00:05,000\nclaims\n";
    const vidA = ctx.videos.importTranscript({ title: "Alpha ep 1", content: srt, format: "srt", publishedAt: "2026-06-01" }).video;
    const vidA2 = ctx.videos.importTranscript({ title: "Alpha ep 2", content: srt, format: "srt", publishedAt: "2026-09-01" }).video;
    const vidB = ctx.videos.importTranscript({ title: "Beta show", content: srt, format: "srt", publishedAt: "2026-09-01" }).video;
    ctx.db.run("UPDATE videos SET channel = 'Alpha Channel' WHERE id IN (?, ?)", vidA.id, vidA2.id);

    const market = ctx.markets.upsertFromSummary({ provider: "polymarket", id: "m1", slug: "btc-150k", url: "https://polymarket.com/market/btc-150k", question: "Will Bitcoin hit $150k by Dec 31, 2026?", outcomes: [{ label: "Yes", tokenId: "y", price: 0.3 }, { label: "No", tokenId: "n", price: 0.7 }], liquidity: 80_000, volume24h: 5000, endDate: "2026-12-31T12:00:00Z", active: true, closed: false, retrievedAt: "2026-09-16T00:00:00Z" });
    const oldMarket = ctx.markets.upsertFromSummary({ provider: "polymarket", id: "m0", slug: "old", url: "https://polymarket.com/market/old", question: "Old question?", outcomes: [{ label: "Yes", tokenId: "oy", price: 1 }, { label: "No", tokenId: "on", price: 0 }], liquidity: 1000, endDate: "2026-07-01T00:00:00Z", active: false, closed: true, retrievedAt: "2026-07-02T00:00:00Z" });

    const mk = (videoId: string, quote: string, deadline: string, madeOn: string) => ctx.predictions.create({
      videoId, quoteExact: quote, normalizedStatement: quote, entities: [], conditions: [], thresholds: [], madeOnDate: madeOn, madeOnBasis: "publication", deadlineDate: deadline, deadlineBasis: "user",
      ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: quote }],
    });
    const settle = (predictionId: string, verdict: "supported" | "contradicted") => {
      const plan = ctx.plans.add({ predictionId, plan: { proposition: "x", components: [], dates: { researchCutoff: "2026-07-02" }, definitions: [], ambiguities: [], supportingEvidence: [], contradictingEvidence: [], partialFulfillmentCriteria: [], queries: { neutral: [], supporting: [], disconfirming: [] }, preferredSourceTypes: [], outputSchemaNotes: "" }, researchPrompt: "x", provider: "app", model: "rule", templateVersion: "test" });
      const run = ctx.research.createRun({ predictionId, planId: plan.id, searchProvider: "none", cutoffDate: "2026-07-02" });
      ctx.research.updateRun(run.id, { status: "completed", finished: true });
      ctx.research.addAssessment({ predictionId, runId: run.id, validationPlanId: plan.id, evidenceAssessment: verdict, timeStatus: "reached", explanation: "fixture", confidence: "high", supportingIds: [], contradictingIds: [], citations: [], guardNotes: [], components: [], provider: "app", model: "rule", templateVersion: "test", researchedAt: "2026-07-02" });
    };

    // Alpha: four settled linked calls at 0.40 — three hits, one miss → realized edge (3·0.6 − 0.4)/4 = 0.35; one open claim linked to the live market.
    const settledA = ["a1", "a2", "a3", "a4"].map((q) => mk(vidA.id, `Alpha settled ${q}`, "2026-07-01", "2026-06-01"));
    settledA.forEach((p, i) => { settle(p.id, i < 3 ? "supported" : "contradicted"); ctx.markets.propose({ predictionId: p.id, marketId: oldMarket.id, side: "Yes", score: 1, matchedBy: "user", status: "accepted", priceAtMade: 0.4 }); });
    const openA = mk(vidA2.id, "Bitcoin will hit 150k by year end", "2026-12-31", "2026-09-01");
    ctx.markets.propose({ predictionId: openA.id, marketId: market.id, side: "Yes", score: 0.8, matchedBy: "rule:text", status: "accepted", priceAtMade: 0.25 });
    // Beta: no channel, one settled unlinked hit, one open claim on the same side; a proposed (not accepted) link must not count.
    const b1 = mk(vidB.id, "Beta old call", "2026-07-01", "2026-06-01");
    settle(b1.id, "supported");
    const openB = mk(vidB.id, "BTC 150k is coming", "2026-12-31", "2026-09-01");
    ctx.markets.propose({ predictionId: openB.id, marketId: market.id, side: "Yes", score: 0.7, matchedBy: "rule:text", status: "accepted" });
    const openC = mk(vidB.id, "Bitcoin will not hit 150k", "2026-12-31", "2026-09-01");
    ctx.markets.propose({ predictionId: openC.id, marketId: market.id, side: "No", score: 0.7, matchedBy: "rule:text" });

    const creators = ctx.signals.creators(gates);
    const alpha = creators.find((c) => c.key === "channel:alpha channel")!;
    assert.ok(alpha, JSON.stringify(creators.map((c) => c.key)));
    assert.equal(alpha.label, "Alpha Channel");
    assert.equal(alpha.predictions, 5);
    assert.equal(alpha.settled, 4);
    assert.equal(alpha.hits, 3);
    assert.equal(alpha.hitRate, 0.75);
    assert.equal(alpha.linkedSettled, 4);
    assert.equal(alpha.realizedEdge, 0.35);
    assert.equal(alpha.shrunkEdge, 0.1);
    assert.equal(alpha.open, 1);
    const beta = creators.find((c) => c.key === `video:${vidB.id}`)!;
    assert.equal(beta.label, "Beta show (no channel)");
    assert.equal(beta.settled, 1);
    assert.equal(beta.linkedSettled, 0, "unlinked settled claims carry no market record");
    assert.equal(beta.realizedEdge, undefined);

    const signals = ctx.signals.signals(gates);
    assert.equal(signals.length, 1, JSON.stringify(signals.map((s) => [s.question, s.side])));
    const s = signals[0];
    assert.equal(s.side, "Yes");
    assert.equal(s.marketPrice, 0.3);
    assert.equal(s.liquidity, 80_000);
    assert.equal(s.contributions.length, 2, "Alpha open + Beta open (accepted); the proposed No link is excluded");
    assert.equal(s.creators, 2);
    assert.equal(s.edge, 0.1, "Beta has no record → only Alpha's shrunk edge counts");
    assert.equal(s.estimate, 0.4);
    assert.equal(s.deadlineCheck, "consistent");
    assert.equal(s.confidence, "lean", s.reasons.join(" | "));
    assert.match(s.reasons.join(" "), /record 4 settled, edge \+10\.0 pts/);
    assert.equal(s.contributions.find((c) => c.creatorKey === alpha.key)?.priceAtMade, 0.25);

    // Tighten the gate → no label, with the reason.
    const strict = ctx.signals.signals({ ...gates, minSettledLean: 5 })[0];
    assert.equal(strict.confidence, "none");
    assert.match(strict.reasons.join(" "), /record too thin \(4 settled, need 5\)/);
    // includeSettled shows the old market's Yes side too.
    assert.equal(ctx.signals.signals(gates, { includeSettled: true }).length, 2);
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});
