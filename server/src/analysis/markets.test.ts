/**
 * Prediction Ledger — tests for market matching (1.6): scorers, the match job (proposals, sports
 * auto-accept, model relation labels), the snapshot job, and link/service behaviour.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ModelInfo, Prediction, ProviderTestResult, SportsPick } from "@prediction-ledger/shared";
import type { CompletionRequest, CompletionResult, LanguageModelProvider, ProviderCredentials } from "../providers/llm/types.js";
import { setLlmProviderForTests } from "../providers/llm/registry.js";
import { setMarketProviderForTests } from "../providers/markets/registry.js";
import type { MarketProvider, MarketSummary, OrderBookSnapshot } from "../providers/markets/types.js";
import { buildMarketQueries, scoreSportsMarket, scoreTextMarket, tokenize } from "./markets.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = "2026-09-16T00:00:00Z";
const mk = (o: Partial<MarketSummary> & { id: string; question: string }): MarketSummary => ({
  provider: "polymarket", slug: o.id, url: `https://polymarket.com/market/${o.id}`, outcomes: [{ label: "Yes", tokenId: "y" + o.id, price: 0.3 }, { label: "No", tokenId: "n" + o.id, price: 0.7 }],
  active: true, closed: false, liquidity: 50_000, volume: 100_000, retrievedAt: now, ...o,
});

const btcMarket = mk({ id: "1", question: "Will Bitcoin hit $150k by December 31, 2026?", endDate: "2026-12-31T12:00:00Z", event: { id: "e1", slug: "btc-2026", title: "Bitcoin price 2026" }, description: "Resolves Yes if BTC/USD trades at or above $150,000 on Coinbase before the end date." });
const fedMarket = mk({ id: "2", question: "Will the Fed cut rates in December 2026?", endDate: "2026-12-20T12:00:00Z" });
const gameMarket = mk({ id: "3", question: "Lions vs. Bills", event: { id: "e3", slug: "lions-vs-bills", title: "Lions vs. Bills" }, endDate: "2026-09-20T23:00:00Z", outcomes: [{ label: "Lions", tokenId: "l", price: 0.42 }, { label: "Bills", tokenId: "b", price: 0.58 }] });
const spreadMarket = mk({ id: "4", question: "Bills -3.5", event: { id: "e3", slug: "lions-vs-bills", title: "Lions vs. Bills (Spread & Total)" }, endDate: "2026-09-20T23:00:00Z", outcomes: [{ label: "Bills", tokenId: "bs", price: 0.5 }, { label: "Lions", tokenId: "ls", price: 0.5 }] });
const champMarket = mk({ id: "5", question: "Will the Buffalo Bills win the 2027 NFL league championship?", event: { id: "e5", slug: "champ", title: "Pro Football: 2027 Champion" }, endDate: "2027-03-31T23:55:00Z" });

test("tokenize and buildMarketQueries", () => {
  assert.deepEqual(tokenize("Bitcoin will hit $150k by the end of 2026"), ["bitcoin", "hit", "150k", "end", "2026"]);
  const p = { kind: "general", normalizedStatement: "Bitcoin will reach $150k before the end of 2026", entities: ["Bitcoin"] } as Prediction;
  assert.match(buildMarketQueries(p)[0], /^Bitcoin bitcoin reach/);
  const sp = { kind: "sports_pick", sportsPick: { sport: "NFL", teams: ["Detroit Lions", "Buffalo Bills"], pick: { type: "moneyline", team: "Bills" } } } as Prediction;
  assert.deepEqual(buildMarketQueries(sp), ["lions bills", "Detroit Lions vs Buffalo Bills"]);
});

test("scoreTextMarket: shared terms, numbers and deadline; negation flips side; unrelated markets score low", () => {
  const p = { kind: "general", normalizedStatement: "Bitcoin will reach $150k before the end of 2026", entities: ["Bitcoin"], deadlineDate: "2026-12-31", conditions: [] } as unknown as Prediction;
  const good = scoreTextMarket(p, btcMarket);
  const bad = scoreTextMarket(p, fedMarket);
  assert.ok(good.score > 0.5, `good ${good.score} ${good.rationale}`);
  assert.ok(bad.score < 0.25, `bad ${bad.score} ${bad.rationale}`);
  assert.equal(good.side, "Yes");
  assert.equal(scoreTextMarket({ ...p, normalizedStatement: "Bitcoin will not reach $150k in 2026" } as Prediction, btcMarket).side, "No");
});

test("scoreSportsMarket: moneyline exact on teams + date + type; spread market not exact for a moneyline pick; futures market rejected by date", () => {
  const pick: SportsPick = { sport: "NFL", teams: ["Detroit Lions", "Buffalo Bills"], eventDate: "2026-09-20", pick: { type: "moneyline", team: "Buffalo Bills" } };
  const g = scoreSportsMarket(pick, gameMarket);
  assert.equal(g.relation, "exact", g.rationale);
  assert.equal(g.side, "Bills");
  const s = scoreSportsMarket(pick, spreadMarket);
  assert.notEqual(s.relation, "exact");
  assert.ok(s.score < g.score);
  const c = scoreSportsMarket(pick, champMarket);
  assert.ok(c.score < 0.4, `${c.score} ${c.rationale}`);
  const spreadPick: SportsPick = { ...pick, pick: { type: "spread", team: "Buffalo Bills", line: -3.5 } };
  assert.equal(scoreSportsMarket(spreadPick, spreadMarket).relation, "exact");
  assert.equal(scoreSportsMarket(spreadPick, spreadMarket).side, "Bills");
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

class FakeModel implements LanguageModelProvider {
  readonly id = "lmstudio" as const;
  readonly displayName = "fake";
  readonly isLocal = true;
  requests: CompletionRequest[] = [];
  async testConnection(): Promise<ProviderTestResult> { return { ok: true, provider: this.id, message: "fake" }; }
  async listModels(): Promise<ModelInfo[]> { return []; }
  async complete(_c: ProviderCredentials, req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    if (req.jsonSchema?.name === "market_match") return { text: JSON.stringify({ matches: [{ market_id: "1", relation: "same", side: "Yes", rationale: "Same threshold and year." }, { market_id: "2", relation: "different", side: null, rationale: "Rates, not bitcoin." }] }), model: req.model };
    return { text: "{}", model: req.model };
  }
}
class FakeMarkets implements MarketProvider {
  readonly id = "polymarket" as const;
  searches: string[] = [];
  gets: string[] = [];
  price = 0.3;
  async search(q: string): Promise<MarketSummary[]> {
    this.searches.push(q);
    if (/lions|bills/i.test(q)) return [gameMarket, spreadMarket, champMarket];
    return [btcMarket, fedMarket];
  }
  async get(id: string): Promise<MarketSummary | undefined> {
    this.gets.push(id);
    const m = [btcMarket, fedMarket, gameMarket, spreadMarket, champMarket].find((x) => x.id === id || x.slug === id);
    return m ? { ...m, outcomes: m.outcomes.map((o, i) => ({ ...o, price: i === 0 ? this.price : +(1 - this.price).toFixed(4) })), retrievedAt: new Date().toISOString() } : undefined;
  }
  async list(): Promise<MarketSummary[]> { return [btcMarket]; }
  async book(tokenId: string): Promise<OrderBookSnapshot> { return { provider: "polymarket", tokenId, bids: [], asks: [], retrievedAt: now }; }
}

let fake: FakeModel;
const markets = new FakeMarkets();
before(() => {
  fake = new FakeModel();
  setLlmProviderForTests("lmstudio", fake);
  setMarketProviderForTests("polymarket", markets);
});
after(() => { setMarketProviderForTests("polymarket", undefined); delete process.env.PL_DATA_DIR; });

async function makeCtx() {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-markets-"));
  const { createContext } = await import("../context.js");
  const ctx = createContext();
  const s = ctx.settings.getPersisted();
  s.providers.lmstudio.enabled = true;
  s.providers.lmstudio.model = "fake";
  s.stages = { extraction: { provider: "lmstudio" }, validationPlan: { provider: "lmstudio" }, assessment: { provider: "lmstudio" } };
  s.privacy.allowInternet = true;
  ctx.settings.savePersisted(s);
  const { video } = ctx.videos.importTranscript({ title: "Macro + picks", content: "1\n00:00:00,000 --> 00:00:05,000\nBitcoin hits 150k this year and the Bills beat the Lions.\n", format: "srt", publishedAt: "2026-09-09" });
  const waitFor = async (id: string) => {
    const t0 = Date.now();
    for (;;) {
      const j = ctx.jobs.get(id)!;
      if (["completed", "failed", "cancelled"].includes(j.status)) return j;
      if (Date.now() - t0 > 15_000) throw new Error(`job ${id} timed out (${j.status})`);
      await sleep(100);
    }
  };
  return { ctx, video, waitFor };
}

test("market.match: general prediction → scored proposals with model relation labels; nothing auto-accepted; user accepts", async () => {
  const { ctx, video, waitFor } = await makeCtx();
  ctx.jobs.start();
  try {
    const p = ctx.predictions.create({
      videoId: video.id, quoteExact: "Bitcoin hits 150k this year, mark my words.", normalizedStatement: "Bitcoin will reach $150k before the end of 2026", entities: ["Bitcoin"], conditions: [], thresholds: ["$150k"],
      madeOnDate: "2026-09-09", madeOnBasis: "publication", deadlineDate: "2026-12-31", deadlineBasis: "rule:relative", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: "Bitcoin reaches $150k by end of 2026" }],
    });
    const j = await waitFor(ctx.jobs.enqueue({ kind: "market.match", subjectType: "prediction", subjectId: p.id, payload: { predictionId: p.id } }));
    assert.equal(j.status, "completed", j.error);
    const links = ctx.markets.linksForPrediction(p.id);
    assert.ok(links.length >= 1);
    assert.ok(links.every((l) => l.status === "proposed"), "general predictions are never auto-linked");
    const top = links[0];
    assert.equal(top.market?.question, btcMarket.question);
    assert.equal(top.relation, "same");
    assert.equal(top.side, "Yes");
    assert.match(top.rationale ?? "", /model: Same threshold/);
    assert.equal(top.priceAtMade, 0.3, "side price from the snapshot taken at link time");
    assert.ok(!links.some((l) => l.market?.question === fedMarket.question && l.score > 0.3), "different-relation market pushed down");
    assert.equal(fake.requests.filter((r) => r.jsonSchema?.name === "market_match").length, 1);
    assert.equal(ctx.markets.setLinkStatus(top.id, "accepted")?.status, "accepted");
    // A re-run keeps the accepted status.
    const j2 = await waitFor(ctx.jobs.enqueue({ kind: "market.match", subjectType: "prediction", subjectId: p.id, payload: { predictionId: p.id } }));
    assert.equal(j2.status, "completed", j2.error);
    assert.equal(ctx.markets.linksForPrediction(p.id)[0].status, "accepted");
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});

test("market.match: sports pick → exact moneyline auto-accepted with the picked team as side; snapshot job refreshes linked markets", async () => {
  const { ctx, video, waitFor } = await makeCtx();
  ctx.jobs.start();
  try {
    const pick: SportsPick = { sport: "NFL", teams: ["Detroit Lions", "Buffalo Bills"], eventDate: "2026-09-20", pick: { type: "moneyline", team: "Buffalo Bills" } };
    const p = ctx.predictions.create({
      videoId: video.id, kind: "sports_pick", sportsPick: pick, quoteExact: "Bills beat the Lions this week, easy.", normalizedStatement: "Buffalo Bills beat Detroit Lions (NFL on 2026-09-20)", entities: [], conditions: [], thresholds: [],
      madeOnDate: "2026-09-09", madeOnBasis: "publication", deadlineDate: "2026-09-20", deadlineBasis: "rule:event", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: "Buffalo Bills beat Detroit Lions" }],
    });
    const modelCalls = fake.requests.length;
    const j = await waitFor(ctx.jobs.enqueue({ kind: "market.match", subjectType: "prediction", subjectId: p.id, payload: { predictionId: p.id } }));
    assert.equal(j.status, "completed", j.error);
    assert.equal(fake.requests.length, modelCalls, "no model call for sports picks");
    const links = ctx.markets.linksForPrediction(p.id);
    const accepted = links.filter((l) => l.status === "accepted");
    assert.equal(accepted.length, 1, JSON.stringify(links.map((l) => [l.market?.question, l.status, l.score, l.relation])));
    assert.equal(accepted[0].market?.question, "Lions vs. Bills");
    assert.equal(accepted[0].side, "Bills");
    assert.equal(accepted[0].matchedBy, "rule:sports");

    // snapshot job: linked markets refreshed with the provider's current price
    markets.price = 0.61;
    const before = ctx.markets.snapshots(accepted[0].marketId).length;
    const sj = await waitFor(ctx.jobs.enqueue({ kind: "market.snapshot", subjectType: "market", subjectId: "all", payload: {} }));
    assert.equal(sj.status, "completed", sj.error);
    const snaps = ctx.markets.snapshots(accepted[0].marketId);
    assert.equal(snaps.length, before + 1);
    assert.equal(snaps[0].prices[0].price, 0.61);
    assert.equal(ctx.markets.get(accepted[0].marketId)?.latest?.prices[0].price, 0.61);
    assert.ok(markets.gets.includes("3"));

    // watch + unwatch + delete cascade
    const w = ctx.markets.upsertFromSummary(fedMarket, { watched: true });
    assert.ok(ctx.markets.refreshable().some((m) => m.id === w.id));
    ctx.markets.setWatched(w.id, false);
    assert.ok(!ctx.markets.refreshable().some((m) => m.id === w.id));
    assert.equal(ctx.markets.delete(accepted[0].marketId), true);
    assert.equal(ctx.markets.linksForPrediction(p.id).length, links.length - 1, "link removed with its market");
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});
