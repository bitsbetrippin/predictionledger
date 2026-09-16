/**
 * Prediction Ledger — paper-trading tests (1.9): sizing, marks, resolution close, book stats, auto-open.
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
import { normalizeGammaMarket } from "../providers/markets/polymarket.js";
import { stakeFor } from "./paper.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
after(() => { delete process.env.PL_DATA_DIR; });

test("stakeFor: fixed stake capped by bankroll fraction; Kelly on the edge; no bet when estimate ≤ price", () => {
  const fixed = { sizing: "fixed" as const, fixedStake: 25, kellyFraction: 0.25, maxStakeFraction: 0.1 };
  assert.equal(stakeFor(fixed, 1000, 0.4, 0.6).stake, 25);
  assert.equal(stakeFor(fixed, 100, 0.4, 0.6).stake, 10, "cap = 10% of bankroll");
  const kelly = { ...fixed, sizing: "kelly" as const };
  // f* = (0.6 − 0.4) / 0.6 = 0.333; × 0.25 × 1000 = 83.3; cap 100 → 83.33
  assert.equal(stakeFor(kelly, 1000, 0.4, 0.6).stake, 83.33);
  assert.equal(stakeFor(kelly, 1000, 0.4, 0.9).stake, 100, "capped at max fraction");
  assert.equal(stakeFor(kelly, 1000, 0.4, 0.4).stake, 0);
  assert.match(stakeFor(kelly, 1000, 0.4, undefined).note, /fixed stake used/);
});

test("Polymarket resolution: closed market with a side at ≥ 0.98 is resolved to that side", () => {
  const m = normalizeGammaMarket({ id: "1", question: "q", slug: "q", outcomes: '["Yes","No"]', outcomePrices: '["0.999","0.001"]', clobTokenIds: '["a","b"]', active: false, closed: true } as never);
  assert.equal(m.resolved, true);
  assert.equal(m.resolvedOutcome, "Yes");
  const open = normalizeGammaMarket({ id: "2", question: "q", slug: "q", outcomes: '["Yes","No"]', outcomePrices: '["0.6","0.4"]', clobTokenIds: '["a","b"]', active: true, closed: false } as never);
  assert.equal(open.resolved, undefined);
});

const summary = (o: Partial<MarketSummary> & { id: string; question: string; price: number; retrievedAt: string }): MarketSummary => ({
  provider: "polymarket", slug: o.id, url: `https://polymarket.com/market/${o.id}`, outcomes: [{ label: "Yes", tokenId: "y", price: o.price }, { label: "No", tokenId: "n", price: +(1 - o.price).toFixed(4) }], active: true, closed: false, liquidity: 50_000, ...o,
});

test("PaperService: open → mark → close on resolution; book totals, Brier estimate vs market; manual close; reset", async () => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-paper-"));
  const { createContext } = await import("../context.js");
  const ctx = createContext();
  try {
    const m1 = ctx.markets.upsertFromSummary(summary({ id: "m1", question: "A?", price: 0.4, retrievedAt: "2026-09-01T00:00:00Z" }));
    const m2 = ctx.markets.upsertFromSummary(summary({ id: "m2", question: "B?", price: 0.5, retrievedAt: "2026-09-01T00:00:00Z" }));
    const p1 = ctx.paper.open({ marketId: m1.id, side: "Yes", price: 0.4, stake: 40, source: "signal", edge: 0.2, estimate: 0.6, confidence: "moderate" });
    assert.equal(p1.shares, 100);
    assert.equal(p1.unrealizedPnl, 0);
    const p2 = ctx.paper.open({ marketId: m2.id, side: "No", price: 0.5, stake: 50, source: "manual" });
    assert.throws(() => ctx.paper.open({ marketId: m1.id, side: "Yes", price: 1, stake: 10, source: "manual" }), /needs 0 < price < 1/);

    // Prices move: A Yes 0.4 → 0.7, B No 0.5 → 0.45.
    ctx.markets.upsertFromSummary(summary({ id: "m1", question: "A?", price: 0.7, retrievedAt: "2026-09-02T00:00:00Z" }));
    ctx.markets.upsertFromSummary(summary({ id: "m2", question: "B?", price: 0.55, retrievedAt: "2026-09-02T00:00:00Z" }));
    const t1 = new Date(Date.now() + 1000).toISOString();
    const mk = ctx.paper.markAll(t1);
    assert.deepEqual(mk, { marked: 2, closed: 0 });
    assert.equal(ctx.paper.get(p1.id)!.unrealizedPnl, 30, "100 shares × (0.7 − 0.4)");
    assert.equal(ctx.paper.get(p2.id)!.unrealizedPnl, -5);
    let book = ctx.paper.book({ enabled: true, bankroll: 1000 });
    assert.equal(book.unrealizedPnl, 25);
    assert.equal(book.equity, 1025);
    assert.equal(book.openCount, 2);
    assert.ok(book.curve.length >= 2 && book.curve[book.curve.length - 1].equity === 1025, JSON.stringify(book.curve));

    // A resolves Yes: closes at 1 → +60 realized; B still open.
    ctx.markets.upsertFromSummary(summary({ id: "m1", question: "A?", price: 0.999, retrievedAt: "2026-09-03T00:00:00Z", closed: true, active: false, resolved: true, resolvedOutcome: "Yes" }));
    const mk2 = ctx.paper.markAll(new Date(Date.now() + 2000).toISOString());
    assert.equal(mk2.closed, 1);
    const c1 = ctx.paper.get(p1.id)!;
    assert.equal(c1.status, "closed");
    assert.equal(c1.closeReason, "resolved");
    assert.equal(c1.closedPrice, 1);
    assert.equal(c1.realizedPnl, 60);
    book = ctx.paper.book({ enabled: true, bankroll: 1000 });
    assert.equal(book.realizedPnl, 60);
    assert.equal(book.bankroll, 1060);
    assert.equal(book.wins, 1);
    assert.equal(book.returnOnStake, 1.5, "60 / 40");
    assert.equal(book.brierEstimate, +((0.6 - 1) ** 2).toFixed(4), "(estimate − outcome)²");
    assert.equal(book.brierMarket, +((0.4 - 1) ** 2).toFixed(4), "(price at open − outcome)²");
    assert.ok(book.brierEstimate! < book.brierMarket!, "the estimate was closer than the market on this one");

    // Manual close of B at the current mark (0.45 for No): −5 realized.
    const c2 = ctx.paper.close(p2.id, ctx.paper.get(p2.id)!.currentPrice!, "manual")!;
    assert.equal(c2.realizedPnl, -5);
    book = ctx.paper.book({ enabled: true, bankroll: 1000 });
    assert.equal(book.openCount, 0);
    assert.equal(book.losses, 1);
    assert.equal(book.realizedPnl, 55);
    assert.equal(ctx.paper.reset(), 2);
    assert.equal(ctx.paper.list().length, 0);
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});

test("market.watch auto-opens a paper position on a labelled signal (opt-in), once, sized from settings", async () => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-paper-auto-"));
  const { createContext } = await import("../context.js");
  const ctx = createContext();
  try {
    const s = ctx.settings.getPersisted();
    s.markets.paper = { enabled: true, bankroll: 1000, sizing: "kelly", fixedStake: 25, kellyFraction: 0.25, maxStakeFraction: 0.1, autoOpen: "lean", maxOpenPositions: 5 };
    s.markets.watch = { enabled: true, movePts: 50, divergencePts: 50, resolveDays: 1 };
    ctx.settings.savePersisted(s);
    const srt = "1\n00:00:00,000 --> 00:00:05,000\nclaims\n";
    const vid = ctx.videos.importTranscript({ title: "Alpha", content: srt, format: "srt", publishedAt: "2026-09-01" }).video;
    ctx.db.run("UPDATE videos SET channel = 'Alpha' WHERE id = ?", vid.id);
    const old = ctx.markets.upsertFromSummary(summary({ id: "m0", question: "Old?", price: 1, retrievedAt: "2026-07-02T00:00:00Z", closed: true, active: false }));
    const live = ctx.markets.upsertFromSummary(summary({ id: "m1", question: "Live?", price: 0.3, retrievedAt: new Date().toISOString(), endDate: "2026-12-31T00:00:00Z" }));
    const mk = (quote: string, deadline: string, madeOn: string) => ctx.predictions.create({ videoId: vid.id, quoteExact: quote, normalizedStatement: quote, entities: [], conditions: [], thresholds: [], madeOnDate: madeOn, madeOnBasis: "publication", deadlineDate: deadline, deadlineBasis: "user", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: quote }] });
    for (let i = 0; i < 5; i++) {
      const p = mk(`settled ${i}`, "2026-07-01", "2026-06-01");
      const plan = ctx.plans.add({ predictionId: p.id, plan: { proposition: "x", components: [], dates: { researchCutoff: "2026-07-02" }, definitions: [], ambiguities: [], supportingEvidence: [], contradictingEvidence: [], partialFulfillmentCriteria: [], queries: { neutral: [], supporting: [], disconfirming: [] }, preferredSourceTypes: [], outputSchemaNotes: "" }, researchPrompt: "x", provider: "app", model: "rule", templateVersion: "t" });
      const run = ctx.research.createRun({ predictionId: p.id, planId: plan.id, searchProvider: "none", cutoffDate: "2026-07-02" });
      ctx.research.updateRun(run.id, { status: "completed", finished: true });
      ctx.research.addAssessment({ predictionId: p.id, runId: run.id, validationPlanId: plan.id, evidenceAssessment: "supported", timeStatus: "reached", explanation: "f", confidence: "high", supportingIds: [], contradictingIds: [], citations: [], guardNotes: [], components: [], provider: "app", model: "rule", templateVersion: "t", researchedAt: "2026-07-02" });
      ctx.markets.propose({ predictionId: p.id, marketId: old.id, side: "Yes", score: 1, matchedBy: "user", status: "accepted", priceAtMade: 0.4 });
    }
    const open = mk("Live will happen", "2026-12-31", "2026-09-01");
    ctx.markets.propose({ predictionId: open.id, marketId: live.id, side: "Yes", score: 0.9, matchedBy: "user", status: "accepted", priceAtMade: 0.3 });
    // Record: 5 hits at 0.40 → realized edge 0.6, shrunk 5/15 → 0.2 → lean (≥3 settled, ≥3 pts). Estimate 0.5.
    ctx.jobs.start();
    const j = ctx.jobs.enqueue({ kind: "market.watch", subjectType: "market", subjectId: "all", payload: {} });
    for (let i = 0; i < 100 && !["completed", "failed"].includes(ctx.jobs.get(j)!.status); i++) await sleep(100);
    assert.equal(ctx.jobs.get(j)!.status, "completed", ctx.jobs.get(j)!.error);
    const positions = ctx.paper.list();
    assert.equal(positions.length, 1, JSON.stringify(ctx.jobs.get(j)!.result));
    const pos = positions[0];
    assert.equal(pos.source, "auto");
    assert.equal(pos.side, "Yes");
    assert.equal(pos.openedPrice, 0.3);
    assert.equal(pos.confidenceAtOpen, "lean");
    assert.equal(pos.estimateAtOpen, 0.5);
    // Kelly: (0.5 − 0.3)/0.7 = 0.2857 × 0.25 × 1000 = 71.43; cap 100
    assert.equal(pos.stake, 71.43);
    assert.deepEqual(pos.predictionIds, [open.id]);
    // Second run: no duplicate.
    const j2 = ctx.jobs.enqueue({ kind: "market.watch", subjectType: "market", subjectId: "all", payload: { again: 1 } });
    for (let i = 0; i < 100 && !["completed", "failed"].includes(ctx.jobs.get(j2)!.status); i++) await sleep(100);
    assert.equal(ctx.paper.list().length, 1);
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});
