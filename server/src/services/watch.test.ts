/**
 * Prediction Ledger — tests for watch rules / alerts and cross-channel consensus (1.8).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { MarketSummary } from "../providers/markets/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
after(() => { delete process.env.PL_DATA_DIR; });

const gates = { priorWeight: 10, minSettledLean: 3, minSettledModerate: 8, minSettledStrong: 20, minLiquidity: 10_000 };
const summary = (o: Partial<MarketSummary> & { id: string; question: string; price: number; retrievedAt: string; liquidity?: number }): MarketSummary => ({
  provider: "polymarket", slug: o.id, url: `https://polymarket.com/market/${o.id}`, outcomes: [{ label: "Yes", tokenId: "y", price: o.price }, { label: "No", tokenId: "n", price: +(1 - o.price).toFixed(4) }], active: true, closed: false, liquidity: o.liquidity ?? 50_000, ...o,
});

test("market.watch: price-move, divergence and resolving-soon alerts, each raised once; dismiss; consensus groups by market and by text with disagreement", async () => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-watch-"));
  const { createContext } = await import("../context.js");
  const ctx = createContext();
  try {
    const s = ctx.settings.getPersisted();
    s.markets.watch = { enabled: true, movePts: 10, divergencePts: 10, resolveDays: 7 };
    ctx.settings.savePersisted(s);
    const srt = "1\n00:00:00,000 --> 00:00:05,000\nclaims\n";
    const vidA = ctx.videos.importTranscript({ title: "Alpha ep", content: srt, format: "srt", publishedAt: "2026-09-01" }).video;
    const vidB = ctx.videos.importTranscript({ title: "Beta ep", content: srt, format: "srt", publishedAt: "2026-09-10" }).video;
    const vidC = ctx.videos.importTranscript({ title: "Gamma ep", content: srt, format: "srt", publishedAt: "2026-09-12" }).video;
    ctx.db.run("UPDATE videos SET channel = 'Alpha' WHERE id = ?", vidA.id);
    ctx.db.run("UPDATE videos SET channel = 'Beta' WHERE id = ?", vidB.id);
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    // Market moved 0.30 → 0.45 over ~24 h; ends in 3 days.
    const m = ctx.markets.upsertFromSummary(summary({ id: "m1", question: "Will X happen?", price: 0.3, retrievedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(), endDate: soon }), { watched: true });
    ctx.markets.upsertFromSummary(summary({ id: "m1", question: "Will X happen?", price: 0.45, retrievedAt: new Date().toISOString(), endDate: soon }));
    const mk = (videoId: string, quote: string, madeOn: string) => ctx.predictions.create({ videoId, quoteExact: quote, normalizedStatement: quote, entities: [], conditions: [], thresholds: [], madeOnDate: madeOn, madeOnBasis: "publication", deadlineDate: soon.slice(0, 10), deadlineBasis: "user", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: quote }] });
    // Alpha: a strong settled record (25 linked hits at 0.40 → edge +0.60, shrunk 0.4286) on an old market, and an open claim on m1 Yes.
    const old = ctx.markets.upsertFromSummary(summary({ id: "m0", question: "Old?", price: 1, retrievedAt: "2026-07-02T00:00:00Z", endDate: "2026-07-01T00:00:00Z", closed: true, active: false }));
    for (let i = 0; i < 25; i++) {
      const p = mk(vidA.id, `Alpha settled ${i}`, "2026-06-01");
      const plan = ctx.plans.add({ predictionId: p.id, plan: { proposition: "x", components: [], dates: { researchCutoff: "2026-07-02" }, definitions: [], ambiguities: [], supportingEvidence: [], contradictingEvidence: [], partialFulfillmentCriteria: [], queries: { neutral: [], supporting: [], disconfirming: [] }, preferredSourceTypes: [], outputSchemaNotes: "" }, researchPrompt: "x", provider: "app", model: "rule", templateVersion: "t" });
      const run = ctx.research.createRun({ predictionId: p.id, planId: plan.id, searchProvider: "none", cutoffDate: "2026-07-02" });
      ctx.research.updateRun(run.id, { status: "completed", finished: true });
      ctx.research.addAssessment({ predictionId: p.id, runId: run.id, validationPlanId: plan.id, evidenceAssessment: "supported", timeStatus: "reached", explanation: "f", confidence: "high", supportingIds: [], contradictingIds: [], citations: [], guardNotes: [], components: [], provider: "app", model: "rule", templateVersion: "t", researchedAt: "2026-07-02" });
      ctx.markets.propose({ predictionId: p.id, marketId: old.id, side: "Yes", score: 1, matchedBy: "user", status: "accepted", priceAtMade: 0.4 });
    }
    const openA = mk(vidA.id, "X will happen this year", "2026-09-01");
    ctx.markets.propose({ predictionId: openA.id, marketId: m.id, side: "Yes", score: 0.9, matchedBy: "user", status: "accepted", priceAtMade: 0.3 });
    // Beta disagrees on the same market.
    const openB = mk(vidB.id, "X will not happen", "2026-09-10");
    ctx.markets.propose({ predictionId: openB.id, marketId: m.id, side: "No", score: 0.9, matchedBy: "user", status: "accepted", priceAtMade: 0.7 });
    // Unlinked text cluster: two videos say the same thing about Y; a third says the opposite.
    mk(vidA.id, "Ethereum will flip Bitcoin by market cap in 2027", "2026-09-01");
    mk(vidB.id, "Ethereum flips Bitcoin market cap in 2027", "2026-09-10");
    mk(vidC.id, "Ethereum will never flip Bitcoin market cap in 2027", "2026-09-12");

    ctx.jobs.start();
    const jobId = ctx.jobs.enqueue({ kind: "market.watch", subjectType: "market", subjectId: "all", payload: {} });
    for (let i = 0; i < 100 && !["completed", "failed"].includes(ctx.jobs.get(jobId)!.status); i++) await sleep(100);
    const j = ctx.jobs.get(jobId)!;
    assert.equal(j.status, "completed", j.error);
    const alerts = ctx.alerts.list();
    const kinds = alerts.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["divergence", "market_move", "resolving_soon"], JSON.stringify(alerts.map((a) => a.message)));
    assert.match(alerts.find((a) => a.kind === "market_move")!.message, /moved \+15\.0 pts \(30% → 45%\)/);
    const div = alerts.find((a) => a.kind === "divergence")!;
    assert.equal(div.side, "Yes");
    assert.match(div.message, /strong/);
    assert.equal(ctx.alerts.openCount(), 3);
    // Second run: nothing new (deduped per day / per market).
    const j2 = ctx.jobs.enqueue({ kind: "market.watch", subjectType: "market", subjectId: "all", payload: { again: 1 } });
    for (let i = 0; i < 100 && !["completed", "failed"].includes(ctx.jobs.get(j2)!.status); i++) await sleep(100);
    assert.equal(ctx.alerts.list().length, 3);
    ctx.alerts.dismiss(div.id);
    assert.equal(ctx.alerts.openCount(), 2);
    assert.equal(ctx.alerts.list({ includeDismissed: true }).length, 3);

    // ---- consensus ----
    const props = ctx.consensus.propositions(gates);
    const byMarket = props.find((p) => p.key === `market:${m.id}`)!;
    assert.ok(byMarket, JSON.stringify(props.map((p) => p.key)));
    assert.equal(byMarket.groupedBy, "market");
    assert.equal(byMarket.disagreement, true);
    assert.deepEqual(byMarket.sides.map((x) => x.side), ["Yes", "No"], "Alpha's record outweighs Beta's fresh but record-less claim");
    assert.ok(byMarket.sides[0].share > 0.8, `share ${byMarket.sides[0].share}`);
    assert.equal(byMarket.marketPrice?.Yes, 0.45);
    assert.equal(byMarket.creators, 2);
    const text = props.find((p) => p.groupedBy === "text")!;
    assert.ok(text, "text cluster found");
    assert.equal(text.disagreement, true);
    assert.equal(text.videos, 3);
    assert.equal(text.sides.find((x) => x.side === "No")?.endorsements.length, 1);
    assert.equal(text.sides.find((x) => x.side === "Yes")?.endorsements.length, 2);
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});
