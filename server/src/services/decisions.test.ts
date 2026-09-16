/**
 * Prediction Ledger — forecasts, decisions, reservations and the US paper engine end to end (1.12: F04, F05, F06, F10, F11, R07, R08, R10 + route guards).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Fixture instants are written into the rows directly (created_at / updated_at / retrieved_at / resolved_at) so that
 * "what the app knew at T" is a fact of the data, not of the wall clock. The fake trading adapter is installed and
 * must record zero calls: nothing in this release reaches a venue's order API.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { CSRF_HEADER, CSRF_VALUE } from "@prediction-ledger/shared";
import type { MarketProvider, MarketSummary, OrderBookSnapshot, PricePoint } from "../providers/markets/types.js";
import { setMarketProviderForTests } from "../providers/markets/registry.js";
import { FakeTradingAdapter } from "../providers/trading/fake.js";
import { setTradingAdapterForTests } from "../providers/trading/registry.js";
import { registerCsrfGuard } from "../security/csrf.js";
import { registerDecisionRoutes } from "../routes/decisions.js";
import { registerTradingRoutes } from "../routes/trading.js";
import { registerExecutionRoutes } from "../routes/execution.js";
import type { AppContext } from "../context.js";
import type { DecisionBook } from "../analysis/tradeDecision.js";
import { D } from "../analysis/decimal.js";

const csrf = { [CSRF_HEADER]: CSRF_VALUE, origin: "http://127.0.0.1:7317" };
const RULES = "If Detroit wins, the market will resolve to Lions. If Buffalo wins, the market will resolve to Bills. If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, this market will resolve 50-50.";
const LIONS = { name: "Detroit Lions", abbreviation: "DET", league: "nfl", alias: "Lions" };
const BILLS = { name: "Buffalo Bills", abbreviation: "BUF", league: "nfl", alias: "Bills" };
const T = "2026-10-01T12:00:00Z";
const BOOK: DecisionBook = { retrievedAt: T, bids: [{ price: "0.49", size: "500" }], asks: [{ price: "0.50", size: "500" }] };
const FEE = { kind: "per_contract" as const, value: "0.02" };

function usMoneyline(id: string, start: string, over: Partial<MarketSummary> & { status?: string; minQuantity?: string } = {}): MarketSummary {
  const { status, minQuantity, ...rest } = over;
  return {
    provider: "polymarket_us", id, slug: `aec-nfl-det-buf-${id}`, url: `https://polymarket.us/event/nfl-det-buf-${id}`, question: `Detroit vs. Buffalo (${id})`, description: RULES,
    event: { id: `ev-${id}`, slug: `nfl-det-buf-${id}`, title: "DET Lions vs BUF Bills" },
    outcomes: [{ label: "Lions", tokenId: `x${id}:YES`, price: 0.45 }, { label: "Bills", tokenId: `x${id}:NO`, price: 0.55 }], endDate: start, active: status ? /OPEN/.test(status) : true, closed: status ? !/OPEN/.test(status) : false, retrievedAt: "2026-09-16T00:00:00Z",
    constraints: { venue: "polymarket_us", slug: `aec-nfl-det-buf-${id}`, status: status ?? "MARKET_STATUS_OPEN", tickSize: "0.01", minQuantity: minQuantity ?? "1", feeCoefficient: "0.06", sides: [{ id: `${id}-l`, label: "Lions", long: true, team: LIONS }, { id: `${id}-b`, label: "Bills", long: false, team: BILLS }], category: "sports", sportsMarketType: "SPORTS_MARKET_TYPE_MONEYLINE", gameStartTime: start, eventStartTime: start, retrievedAt: "2026-09-16T00:00:00Z" },
    ...rest,
  };
}

class FakeUs implements MarketProvider {
  readonly id = "polymarket_us" as const;
  byId = new Map<string, MarketSummary>();
  async search(): Promise<MarketSummary[]> { return []; }
  async get(idOrSlug: string): Promise<MarketSummary | undefined> { return this.byId.get(idOrSlug); }
  async list(): Promise<MarketSummary[]> { return []; }
  async book(tokenId: string): Promise<OrderBookSnapshot> { return { provider: "polymarket_us", tokenId, bids: [{ price: 0.49, size: 500 }], asks: [{ price: 0.5, size: 500 }], retrievedAt: T }; }
  async priceHistory(): Promise<PricePoint[]> { return []; }
  async eventMarkets(): Promise<MarketSummary[]> { return []; }
}

let ctx: AppContext;
let app: ReturnType<typeof Fastify>;
const fakeUs = new FakeUs();
const tradingFake = new FakeTradingAdapter();
let clock = T;
let seq = 0;

before(async () => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-decisions-"));
  setMarketProviderForTests("polymarket_us", fakeUs);
  setTradingAdapterForTests(tradingFake);
  const { createContext } = await import("../context.js");
  ctx = createContext({ now: () => new Date(Date.parse(clock)) });
  const s = ctx.settings.getPersisted();
  s.privacy.allowInternet = true;
  s.markets.venues = ["polymarket", "polymarket_us"];
  ctx.settings.savePersisted(s);
  app = Fastify();
  registerCsrfGuard(app, () => ["http://127.0.0.1:7317"]);
  registerDecisionRoutes(app, ctx);
  registerTradingRoutes(app, ctx);
  registerExecutionRoutes(app, ctx);
});
after(() => { ctx?.db.close(); delete process.env.PL_DATA_DIR; setMarketProviderForTests("polymarket_us", undefined); setTradingAdapterForTests(undefined); });

/** A stored, open US market with one YES-price snapshot at `priceAt`. */
function market(id: string, start: string, opts: { yesPrice?: number; priceAt?: string; minQuantity?: string; event?: MarketSummary["event"] } = {}) {
  const summary = usMoneyline(id, start, { minQuantity: opts.minQuantity, ...(opts.event ? { event: opts.event } : {}) });
  fakeUs.byId.set(id, summary);
  const m = ctx.markets.upsertFromSummary(summary, { snapshot: false });
  if (opts.priceAt) {
    const snap = ctx.markets.addSnapshot(m.id, { ...summary, outcomes: [{ label: "Lions", tokenId: `x${id}:YES`, price: opts.yesPrice ?? 0.45 }, { label: "Bills", tokenId: `x${id}:NO`, price: 1 - (opts.yesPrice ?? 0.45) }] }, "history");
    ctx.db.run("UPDATE market_snapshots SET retrieved_at = ? WHERE id = ?", opts.priceAt, snap.id);
  }
  return ctx.markets.get(m.id)!;
}

/** The venue publishes a resolution; the app observes it at `resolvedAt`. */
function resolve(id: string, outcome: "Lions" | "Bills" | "void", resolvedAt: string) {
  const prev = fakeUs.byId.get(id)!;
  const summary: MarketSummary = { ...prev, resolved: true, resolvedOutcome: outcome, closed: true, active: false, constraints: prev.constraints ? { ...prev.constraints, status: "MARKET_STATUS_RESOLVED" } : undefined };
  fakeUs.byId.set(id, summary);
  const m = ctx.markets.upsertFromSummary(summary, { snapshot: false });
  ctx.db.run("UPDATE markets SET resolved_at = ? WHERE id = ?", resolvedAt, m.id);
  return ctx.markets.get(m.id)!;
}

/** A creator's verified claim on a market, timestamped at `publishedAt` (date-only unless it carries a time). */
function claim(creator: { channelId: string; name: string }, marketId: string, team: "Detroit Lions" | "Buffalo Bills", publishedAt: string, opts: { verify?: boolean; quote?: string; eventDate?: string } = {}) {
  seq += 1;
  const id = `v${String(seq).padStart(4, "0")}${creator.channelId.slice(0, 3)}`;
  const video = ctx.videos.createFromYouTube({ youtubeId: id.padEnd(11, "x").slice(0, 11), url: `https://www.youtube.com/watch?v=${id}`, title: `${creator.name} picks`, publishedAt, channel: creator.name, channelId: creator.channelId, firstSeenAt: publishedAt.length > 10 ? publishedAt : `${publishedAt}T00:00:00.000Z` });
  ctx.videos.applyYouTubeInfo(video.id, { publishedPrecision: publishedAt.length > 10 ? "datetime" : "date" });
  const m = ctx.markets.get(marketId)!;
  const eventDate = opts.eventDate ?? (m.constraints?.gameStartTime ?? "2026-10-01").slice(0, 10);
  const quote = opts.quote ?? `I like the ${team} tonight (${seq})`;
  const p = ctx.predictions.create({ videoId: video.id, kind: "sports_pick", sportsPick: { sport: "NFL", league: "nfl", teams: ["Detroit Lions", "Buffalo Bills"], eventDate, pick: { type: "moneyline", team } }, quoteExact: quote, normalizedStatement: `${team} win`, entities: ["Detroit Lions", "Buffalo Bills"], conditions: [], thresholds: [], madeOnDate: publishedAt.slice(0, 10), madeOnBasis: "publication", deadlineDate: eventDate, deadlineBasis: "rule:absolute", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: `${team} win` }] });
  const link = ctx.markets.propose({ predictionId: p.id, marketId: m.id, side: team === "Detroit Lions" ? "Lions" : "Bills", score: 1, relation: "exact", matchedBy: "rule:sports", status: "accepted" });
  const at = publishedAt.length > 10 ? publishedAt : `${publishedAt}T00:00:00.000Z`;
  ctx.db.run("UPDATE predictions SET created_at = ? WHERE id = ?", at, p.id);
  ctx.db.run("UPDATE prediction_market_links SET updated_at = ?, created_at = ? WHERE id = ?", at, at, link.id);
  let verification;
  if (opts.verify !== false) {
    verification = ctx.contracts.verifyLink(link.id);
    assert.equal(verification.status, "verified_equivalent", `fixture must verify: ${verification.notes}`);
    ctx.db.run("UPDATE contract_verifications SET created_at = ? WHERE id = ?", at, verification.id);
  }
  return { video, prediction: p, link, verification };
}

const A = { channelId: "UC-A", name: "Creator A" };
const B = { channelId: "UC-B", name: "Creator B" };

test("F04/F05 — the trading cohort uses only deduplicated official binary outcomes with a price at or before the claim; voids, pending, unverified, midday-only prices and assessments never train it", () => {
  // Creator A's history: four settled games with a pre-claim price; Lions won three, lost one. Claims are made and
  // verified while the markets are open; the venue resolves afterwards.
  const games: [string, string, string, "Lions" | "Bills"][] = [["g01", "2026-09-01", "2026-08-31T23:00:00Z", "Lions"], ["g02", "2026-09-02", "2026-09-01T23:00:00Z", "Lions"], ["g03", "2026-09-03", "2026-09-02T23:00:00Z", "Lions"], ["g04", "2026-09-04", "2026-09-03T23:00:00Z", "Bills"]];
  for (const [id, day, priceAt, winner] of games) {
    const m = market(id, `${day}T17:00:00Z`, { yesPrice: 0.25, priceAt });
    claim(A, m.id, "Detroit Lions", day);
    resolve(id, winner, `${day}T21:00:00Z`);
  }
  // Excluded kinds.
  const voided = market("g05", "2026-09-05T17:00:00Z", { yesPrice: 0.45, priceAt: "2026-09-04T23:00:00Z" });
  claim(A, voided.id, "Detroit Lions", "2026-09-05");
  resolve("g05", "void", "2026-09-05T21:00:00Z");
  const pending = market("g06", "2026-09-06T17:00:00Z", { yesPrice: 0.45, priceAt: "2026-09-05T23:00:00Z" });
  claim(A, pending.id, "Detroit Lions", "2026-09-06");
  const midday = market("g07", "2026-09-07T17:00:00Z", { yesPrice: 0.45, priceAt: "2026-09-07T12:00:00Z" });
  claim(A, midday.id, "Detroit Lions", "2026-09-07");
  resolve("g07", "Lions", "2026-09-07T21:00:00Z");
  const unverified = market("g08", "2026-09-08T17:00:00Z", { yesPrice: 0.45, priceAt: "2026-09-07T23:00:00Z" });
  claim(A, unverified.id, "Detroit Lions", "2026-09-08", { verify: false });
  resolve("g08", "Lions", "2026-09-08T21:00:00Z");
  // A duplicate claim by the same creator on g01 (a second video, later that day): one observation per creator/contract.
  fakeUs.byId.set("g01", usMoneyline("g01", "2026-09-01T17:00:00Z"));
  ctx.markets.upsertFromSummary(fakeUs.byId.get("g01")!, { snapshot: false }); // reopen for verification…
  claim(A, ctx.markets.findByVenue("polymarket_us", "g01")!.id, "Detroit Lions", "2026-09-01T06:00:00Z");
  resolve("g01", "Lions", "2026-09-01T21:00:00Z"); // …then the resolution stands as before (resolved_at unchanged by COALESCE)
  // A settlement the app only observed after T must not count at T.
  const late = market("g09", "2026-09-09T17:00:00Z", { yesPrice: 0.45, priceAt: "2026-09-08T23:00:00Z" });
  claim(A, late.id, "Detroit Lions", "2026-09-09");
  resolve("g09", "Lions", "2026-10-02T00:00:00Z");

  const cohort = ctx.forecasts.cohort("channel:UC-A", T);
  assert.equal(cohort.observations.length, 4, JSON.stringify(cohort.excluded));
  assert.deepEqual(cohort.observations.map((o) => o.outcome).sort(), [0, 1, 1, 1]);
  assert.ok(cohort.observations.every((o) => o.priceAtClaim === "0.25" && o.side === "yes"));
  const ex = Object.fromEntries(cohort.excluded.map((e) => [e.reason, e.count]));
  assert.equal(ex.void, 1, "a void is reported separately, never a 0.5 payout");
  assert.equal(ex.outcome_pending, 2, "unsettled markets (g06 and the not-yet-observed g09) stay out — a research verdict is never an outcome");
  assert.equal(ex.no_price_at_or_before_claim, 1, "a date-only claim whose only price is midday has no pre-claim price (F05)");
  assert.equal(ex.link_not_verified_equivalent, 1);
  assert.equal(ex.duplicate_creator_contract, 1);
  // The same query as of a later instant picks up g09 (observed 2026-10-02) — replays are a function of the instant.
  assert.equal(ctx.forecasts.cohort("channel:UC-A", "2026-10-03T00:00:00Z").observations.length, 5);
});

test("F06 — a forecast replayed at T is byte-identical (same hash) after later outcomes, later creator wins and a revised transcript arrive", async () => {
  const target = market("ta", "2026-10-01T13:00:00Z", { yesPrice: 0.5, priceAt: "2026-09-30T23:00:00Z" });
  const a = claim(A, target.id, "Detroit Lions", "2026-09-30");
  // Creator B disagrees on the same contract; B has no usable history (weight 0) but stays visible on the record.
  claim(B, target.id, "Buffalo Bills", "2026-09-30T08:00:00Z");
  const f1 = ctx.forecasts.build({ predictionId: a.prediction.id, linkId: a.link.id, asOf: T, book: BOOK });
  assert.equal(f1.status, "experimental");
  assert.equal(f1.prior.p0, "0.495");
  const sel = f1.contributions.filter((c) => c.selected);
  assert.equal(sel.length, 1, "B has no usable history → weight 0; A contributes");
  assert.equal(sel[0].n, 4);
  assert.equal(f1.contributions.find((c) => c.sourceKey === "channel:UC-B")!.reason.startsWith("no usable history"), true);
  assert.ok(D(f1.pYes).gt("0.495"), `A's record pushes YES above the midpoint: ${f1.pYes}`);
  assert.equal(D(f1.pYes).add(f1.pNo).toString(), "1");
  assert.equal(f1.strategyVersion, "baseline-edge-v1");
  assert.ok(f1.expiresAt);
  // Later: g09 gets observed, A wins two more games, B's claim gets edited — all after T.
  const win1 = market("g10", "2026-10-05T17:00:00Z", { yesPrice: 0.45, priceAt: "2026-10-04T23:00:00Z" });
  claim(A, win1.id, "Detroit Lions", "2026-10-05");
  resolve("g10", "Lions", "2026-10-05T21:00:00Z");
  ctx.predictions.edit(a.prediction.id, { normalizedStatement: "Detroit wins outright" }, "edited after T");
  ctx.db.run("UPDATE prediction_revisions SET created_at = '2026-10-06T00:00:00.000Z' WHERE prediction_id = ?", a.prediction.id);
  const f2 = ctx.forecasts.build({ predictionId: a.prediction.id, linkId: a.link.id, asOf: T, book: BOOK });
  assert.notEqual(f2.id, f1.id, "a new immutable snapshot is written");
  assert.equal(f2.hash, f1.hash, "identical inputs at T → identical hash");
  assert.equal(f2.pYes, f1.pYes);
  const f3 = ctx.forecasts.build({ predictionId: a.prediction.id, linkId: a.link.id, asOf: "2026-10-06T00:00:00Z", book: { ...BOOK, retrievedAt: "2026-10-06T00:00:00Z" } });
  assert.equal(f3.contributions.find((c) => c.selected)!.n, 6, "as of a later instant the two later wins count (g09 observed 2026-10-02, g10)");
  assert.notEqual(f3.hash, f1.hash);
  assert.throws(() => ctx.db.run("UPDATE forecast_snapshots SET p_yes = '0.9' WHERE id = ?", f1.id), /immutable/);
});

test("F10 — paper mode, F0 book with only 10 contracts at the limit: 10 fills for $5.20, remainder IOC-canceled, reservation consumed for the fill and released for the rest, zero adapter calls", async () => {
  const target = ctx.markets.findByVenue("polymarket_us", "ta")!;
  const a = ctx.markets.linksForMarket(target.id).find((l) => l.side === "Lions")!;
  const thin: DecisionBook = { retrievedAt: T, bids: [{ price: "0.49", size: "500" }], asks: [{ price: "0.50", size: "10" }, { price: "0.51", size: "500" }] };
  // Force the forecast above the threshold: A's record gives pYes ≈ .55 with p0 .495 — enough for the .03 edge at .52 all-in.
  const d = await ctx.decisions.evaluate({ predictionId: a.predictionId, linkId: a.id, now: T, book: thin, fee: FEE, reuseForecast: false, latencyMs: 250 });
  assert.equal(d.outcome, "eligible", JSON.stringify(d.gates.filter((g) => !g.satisfied)));
  assert.equal(d.mode, "paper");
  assert.deepEqual({ qty: d.sizing!.quantity, worst: d.sizing!.worstCost, side: d.sizing!.side, sideId: d.sizing!.sideId }, { qty: "19", worst: "9.88", side: "yes", sideId: "ta-l" });
  assert.ok(d.intent && d.reservationId && d.paperPosition);
  assert.deepEqual({ state: d.intent!.state, filled: d.intent!.filledQuantity, tif: d.intent!.timeInForce }, { state: "partially_filled", filled: "10", tif: "IOC" });
  assert.deepEqual({ qty: d.paperPosition!.quantity, cost: d.paperPosition!.costTotal, fees: d.paperPosition!.fees, fills: d.paperPosition!.fills.length, method: d.paperPosition!.method }, { qty: "10", cost: "5", fees: "0.2", fills: 1, method: "us-ioc-v1" });
  assert.equal(d.paperPosition!.fills[0].at, "2026-10-01T12:00:00.250Z");
  const res = ctx.risk.get(d.reservationId!)!;
  assert.deepEqual({ state: res.state, amount: res.amount, filled: res.filledAmount, bucket: res.dailyBucket }, { state: "consumed", amount: "9.88", filled: "5.2", bucket: "2026-10-01" });
  const exp = ctx.risk.exposure("paper", "2026-10-01");
  assert.deepEqual({ open: exp.openRiskTotal, daily: exp.dailyCommitted, markets: exp.openMarkets }, { open: "5.2", daily: "5.2", markets: 1 }, "filled commitment is what stays reserved; the unfilled remainder was released");
  assert.equal(tradingFake.calls.length, 0, "no adapter call of any kind");
  assert.equal(ctx.trading.status().submissionAvailable, false);
  const book = ctx.paperUs.book();
  assert.deepEqual({ bankroll: book.bankroll, committed: book.committed, open: book.open, currency: book.currency, method: book.method }, { bankroll: "94.8", committed: "5.2", open: 1, currency: "USD", method: "us-ioc-v1" });
  // The decision is immutable and complete: inputs, gates, rationale hash, forecast link.
  assert.ok(d.rationaleHash.length === 64 && d.forecastId && d.verificationId);
  assert.ok((d.inputs.book as { asks: unknown[] }).asks.length === 2);
  // A second evaluation on the same contract is refused by the consumed opportunity (no pyramiding / re-entry / IOC retry).
  const again = await ctx.decisions.evaluate({ predictionId: a.predictionId, linkId: a.id, now: "2026-10-01T12:01:00Z", book: { ...thin, retrievedAt: "2026-10-01T12:01:00Z" }, fee: FEE });
  assert.equal(again.outcome, "skipped");
  assert.ok(again.reasonCodes.includes("OPPORTUNITY_CONSUMED"));
  assert.equal(ctx.decisions.list({ outcome: "skipped" }).length, 1, "skipped decisions are saved too");
});

test("R07 — two concurrent workers with $15 unused capacity: exactly one reservation and dispatch; the other gets a budget reason; capacity never negative", async () => {
  const m1 = market("r1", "2026-10-01T13:00:00Z", { minQuantity: "15" });
  const m2 = market("r2", "2026-10-01T13:00:00Z", { minQuantity: "15" });
  const c1 = claim(A, m1.id, "Detroit Lions", "2026-09-30T10:00:00Z");
  const c2 = claim(A, m2.id, "Detroit Lions", "2026-09-30T10:30:00Z");
  ctx.paperUs.setBankrollStart("20.2"); // 20.20 − 5.20 committed = 15.00 unused
  assert.equal(ctx.paperUs.book().bankroll, "15");
  const [d1, d2] = await Promise.all([
    ctx.decisions.evaluate({ predictionId: c1.prediction.id, linkId: c1.link.id, now: T, book: BOOK, fee: FEE }),
    ctx.decisions.evaluate({ predictionId: c2.prediction.id, linkId: c2.link.id, now: T, book: BOOK, fee: FEE }),
  ]);
  const winners = [d1, d2].filter((d) => d.outcome === "eligible");
  const losers = [d1, d2].filter((d) => d.outcome !== "eligible");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(winners[0].sizing!.worstCost, "7.8", "15-contract increment on this fixture: 15 × .52");
  assert.ok(losers[0].reasonCodes.includes("NO_VALID_QUANTITY"), `budget reason: ${losers[0].reasonCodes.join(",")}`);
  assert.equal(losers[0].intentId, undefined);
  const exp = ctx.risk.exposure("paper", "2026-10-01");
  assert.ok(D(ctx.paperUs.book().bankroll).gte("0"));
  assert.equal(exp.openRiskTotal, "13", "5.20 + the new full fill 7.80");
  assert.equal(ctx.paperUs.book().bankroll, "7.2");
  assert.equal(tradingFake.calls.length, 0);
});

test("R08 — daily remainder sizes down; saturated event / count / loss-stop gates block; a winning settlement does not reset the day's consumption", async () => {
  ctx.paperUs.setBankrollStart("1000");
  const m = market("r3", "2026-10-01T13:00:00Z");
  const c = claim(A, m.id, "Detroit Lions", "2026-09-30T11:00:00Z");
  const before = ctx.risk.exposure("paper", "2026-10-01");
  // Daily cap = committed + 5 → the next order must fit $5: 9 contracts, $4.68.
  ctx.trading.setLimits({ dailyCommitmentCap: D(before.dailyCommitted).add("5").toString() });
  const d = await ctx.decisions.evaluate({ predictionId: c.prediction.id, linkId: c.link.id, now: T, book: BOOK, fee: FEE });
  assert.equal(d.outcome, "eligible", JSON.stringify(d.gates.filter((g) => !g.satisfied)));
  assert.deepEqual({ qty: d.sizing!.quantity, worst: d.sizing!.worstCost, by: d.sizing!.boundBy }, { qty: "9", worst: "4.68", by: "daily_cap" });
  // Winning settlement: realized +4.32 on the r3 position; the day's committed amount does not shrink.
  const committedBefore = ctx.risk.exposure("paper", "2026-10-01").dailyCommitted;
  resolve("r3", "Lions", "2026-10-01T15:30:00Z");
  assert.equal(ctx.decisions.settleResolved(m.id, "2026-10-01T16:00:00Z"), 1);
  const pos = ctx.paperUs.list("settled").find((p) => p.marketId === m.id)!;
  assert.deepEqual({ outcome: pos.outcome, pnl: pos.pnl }, { outcome: "win", pnl: "4.32" }, "9 × $1 − 4.50 cost − 0.18 fees");
  assert.equal(ctx.risk.exposure("paper", "2026-10-01").dailyCommitted, committedBefore, "winning settlements never replenish the daily allowance");
  // Event cap reached → EVENT_CAP_REACHED; max open markets → MAX_OPEN_MARKETS; loss stop → DAILY_LOSS_STOP.
  const m4 = market("r4", "2026-10-01T13:00:00Z", { event: { id: "ev-ta", slug: "nfl-det-buf-ta", title: "same event as ta" } });
  assert.equal(m4.event?.id, "ev-ta");
  const c4 = claim(A, m4.id, "Detroit Lions", "2026-09-30T11:30:00Z");
  ctx.trading.setLimits({ dailyCommitmentCap: "50", perEvent: "5" });
  const evt = await ctx.decisions.evaluate({ predictionId: c4.prediction.id, linkId: c4.link.id, now: T, book: BOOK, fee: FEE });
  assert.ok(evt.reasonCodes.includes("EVENT_CAP_REACHED"), evt.reasonCodes.join(","));
  ctx.trading.setLimits({ perEvent: "20", maxOpenMarkets: ctx.risk.exposure("paper", "2026-10-01").openMarkets });
  const cnt = await ctx.decisions.evaluate({ predictionId: c4.prediction.id, linkId: c4.link.id, now: T, book: BOOK, fee: FEE });
  assert.ok(cnt.reasonCodes.includes("MAX_OPEN_MARKETS"), cnt.reasonCodes.join(","));
  ctx.trading.setLimits({ maxOpenMarkets: 5 });
  // A losing settlement of the r1/r2 position (7.80 at stake) trips a $5 loss stop.
  const lost = ctx.paperUs.list("open").find((p) => p.venueMarketId === "r1" || p.venueMarketId === "r2")!;
  const lostId = lost.venueMarketId;
  resolve(lostId, "Bills", "2026-10-01T16:00:00Z");
  assert.equal(ctx.decisions.settleResolved(lost.marketId, "2026-10-01T16:30:00Z"), 1);
  assert.equal(ctx.paperUs.get(lost.id)!.pnl, "-7.8");
  // Net realized loss for the day: +4.32 − 7.80 = −3.48 → a $3 stop trips, a $4 stop does not.
  assert.equal(ctx.risk.exposure("paper", "2026-10-01").dailyRealizedLoss, "3.48");
  ctx.trading.setLimits({ dailyLossStop: "3" });
  const stop = await ctx.decisions.evaluate({ predictionId: c4.prediction.id, linkId: c4.link.id, now: T, book: BOOK, fee: FEE });
  assert.ok(stop.reasonCodes.includes("DAILY_LOSS_STOP"), stop.reasonCodes.join(","));
  ctx.trading.setLimits({ dailyLossStop: "4" });
  const under = await ctx.decisions.evaluate({ predictionId: c4.prediction.id, linkId: c4.link.id, now: T, book: BOOK, fee: FEE, dispatch: false });
  assert.ok(!under.reasonCodes.includes("DAILY_LOSS_STOP"));
  ctx.trading.setLimits({ dailyLossStop: "20" });
  assert.equal(tradingFake.calls.length, 0);
});

test("R10 — a reservation keeps its bucket across midnight; limit and timezone edits are hashed and audited, never reset consumption; a consumed opportunity survives policy edits", async () => {
  const d1 = ctx.risk.exposure("paper", "2026-10-01");
  const d2 = ctx.risk.exposure("paper", "2026-10-02");
  assert.ok(D(d1.dailyCommitted).gt("0"));
  assert.equal(d2.dailyCommitted, "0", "a new day starts empty");
  assert.equal(d2.openRiskTotal, d1.openRiskTotal, "pending exposure carries over");
  const before = ctx.trading.policy();
  const changed = ctx.trading.setLimits({}, { budgetTimezone: "America/New_York" });
  assert.notEqual(changed.policyHash, before.policyHash);
  assert.equal(changed.mode, "paper");
  assert.equal(ctx.risk.exposure("paper", "2026-10-01").dailyCommitted, d1.dailyCommitted, "the timezone change did not move or reset the consumed bucket");
  const audit = ctx.trading.auditEvents(5).find((e) => e.kind === "policy.changed")!;
  assert.deepEqual({ from: audit.details.from, to: audit.details.to, tz: audit.details.budgetTimezone }, { from: before.policyHash, to: changed.policyHash, tz: "America/New_York" });
  assert.equal(ctx.trading.setLimits({}, { budgetTimezone: "America/New_York" }).policyHash, changed.policyHash, "no-op edits do not churn the hash");
  assert.throws(() => ctx.trading.setLimits({}, { budgetTimezone: "Mars/Olympus" }), /Unknown timezone/);
  ctx.trading.setLimits({ orderBudget: "25" }, { budgetTimezone: "UTC" });
  const target = ctx.markets.findByVenue("polymarket_us", "ta")!;
  const a = ctx.markets.linksForMarket(target.id).find((l) => l.side === "Lions")!;
  const again = await ctx.decisions.evaluate({ predictionId: a.predictionId, linkId: a.id, now: "2026-10-01T12:02:00Z", book: { ...BOOK, retrievedAt: "2026-10-01T12:02:00Z" }, fee: FEE });
  assert.ok(again.reasonCodes.includes("OPPORTUNITY_CONSUMED"), "a bigger budget cannot regenerate the consumed opportunity");
  assert.equal(again.policyHash, ctx.trading.policy().policyHash);
  ctx.trading.setLimits({ orderBudget: "10" });
});

test("F11 — legacy paper (USDC + mana), the US paper book and live account balances are reported separately; nothing aggregates mana into dollars", async () => {
  const intl = ctx.markets.upsertFromSummary({ provider: "polymarket", id: "i1", slug: "intl", url: "https://polymarket.com/event/x", question: "Intl?", outcomes: [{ label: "Yes", price: 0.4 }, { label: "No", price: 0.6 }], active: true, closed: false, retrievedAt: T });
  const mana = ctx.markets.upsertFromSummary({ provider: "manifold", id: "mf1", slug: "mana", url: "https://manifold.markets/x", question: "Mana?", outcomes: [{ label: "Yes", price: 0.3 }, { label: "No", price: 0.7 }], active: true, closed: false, retrievedAt: T, tags: ["token:mana"] });
  ctx.paper.open({ marketId: intl.id, side: "Yes", price: 0.4, stake: 10, source: "manual" });
  ctx.paper.open({ marketId: mana.id, side: "Yes", price: 0.3, stake: 500, source: "manual" });
  const legacy = ctx.paper.book({ enabled: true, bankroll: 1000 });
  assert.equal(legacy.method, "legacy-snapshot-v1");
  assert.deepEqual({ usdc: legacy.byCurrency.USDC?.staked, mana: legacy.byCurrency.MANA?.staked }, { usdc: 10, mana: 500 });
  assert.equal(legacy.byCurrency.USD, undefined, "the US paper engine never writes into the legacy book");
  const us = ctx.paperUs.book();
  assert.equal(us.currency, "USD");
  assert.ok(us.positions.every((p) => p.method === "us-ioc-v1"));
  assert.ok(!us.positions.some((p) => p.marketId === mana.id || p.marketId === intl.id));
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM paper_positions WHERE method <> 'legacy-snapshot-v1'")!.n, 0);
  // Routes: the US book and the legacy book are different resources; decisions never accept a budget from the client; there is no direct order route.
  const usRes = await app.inject({ method: "GET", url: "/api/paper/us" });
  assert.equal(usRes.statusCode, 200);
  assert.equal(usRes.json().currency, "USD");
  const bad = await app.inject({ method: "POST", url: "/api/trading/decisions", headers: csrf, payload: { predictionId: "00000000-0000-4000-8000-000000000000", budget: "50" } });
  assert.equal(bad.statusCode, 400, "no client budget override (strict body)");
  const orders = await app.inject({ method: "POST", url: "/api/trading/orders", headers: csrf, payload: {} });
  assert.equal(orders.statusCode, 409, "1.13: no direct order route; preview → confirm only");
  assert.equal(orders.json().error, "preview_required");
  const limits = await app.inject({ method: "GET", url: "/api/trading/limits" });
  assert.equal(limits.json().limits.orderBudget, "10");
  const list = await app.inject({ method: "GET", url: "/api/trading/decisions?mode=paper" });
  assert.ok(list.json().length >= 5);
  const one = list.json().find((d: { intentId?: string }) => d.intentId);
  const ev = await app.inject({ method: "GET", url: `/api/trading/decisions/${one.id}/evidence` });
  assert.equal(ev.statusCode, 200);
  assert.ok(ev.json().forecast && ev.json().verification && ev.json().dossier && ev.json().reservation);
  const evalRes = await app.inject({ method: "GET", url: "/api/forecasts/evaluation?category=sports" });
  assert.equal(evalRes.statusCode, 200);
  assert.equal(evalRes.json().gate.qualified, false, "no production qualification from a handful of fixture decisions");
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM strategy_qualifications WHERE source = 'production'")!.n, 0);
  // A fixture-sourced evaluation record can never qualify a strategy.
  const fixture = ctx.forecasts.evaluate({ category: "sports", record: true, source: "fixture", records: Array.from({ length: 120 }, () => ({ pYes: 0.7, marketPYes: 0.6, outcome: 1 as const, traded: true, creatorObservations: { A: 30, B: 30 }, independentClusters: 2 })) });
  assert.equal(fixture.gate.qualified, true, "the numbers pass the gate…");
  assert.equal(fixture.qualification!.qualified, false, "…but a fixture record never qualifies a strategy");
  assert.equal(ctx.forecasts.productionQualification("baseline-edge-v1", "sports"), undefined);
  assert.equal(ctx.trading.gates().find((g) => g.id === "strategy_qualified")!.satisfied, false);
  assert.equal(tradingFake.calls.length, 0);
});
