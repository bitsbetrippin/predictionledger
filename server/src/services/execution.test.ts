/**
 * Prediction Ledger — manual-live execution against the fake venue (1.13: E01–E12, D01–D04, O01–O03).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Every order here goes to the FakeTradingAdapter's venue; no network, no real key, no real money. The fake venue
 * emits executions on the private stream synchronously (inside the create call), so the "stream before response"
 * ordering that the real venue can produce is exercised on every submission. Fault injection runs the exact
 * production code path with a throw at the named commit point; crash recovery then runs the startup routine.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { CSRF_HEADER, CSRF_VALUE, type TradeDecision, type TradeIntent } from "@prediction-ledger/shared";
import type { MarketProvider, MarketSummary, OrderBookSnapshot, PricePoint } from "../providers/markets/types.js";
import { setMarketProviderForTests } from "../providers/markets/registry.js";
import { FakeTradingAdapter, fakeBalance } from "../providers/trading/fake.js";
import { setTradingAdapterForTests } from "../providers/trading/registry.js";
import { registerCsrfGuard } from "../security/csrf.js";
import { registerDecisionRoutes } from "../routes/decisions.js";
import { registerTradingRoutes } from "../routes/trading.js";
import { registerExecutionRoutes } from "../routes/execution.js";
import { registerContentRoutes } from "../routes/content.js";
import { registerMarketRoutes } from "../routes/markets.js";
import type { AppContext } from "../context.js";
import { ExecutionError, type FaultInjector, type FaultPoint } from "./execution.js";
import { LIVE_ACKNOWLEDGEMENT } from "./tradingAccounts.js";
import { buildExportBundle } from "./export.js";
import { createBackup } from "./backup.js";
import { D } from "../analysis/decimal.js";

const csrf = { [CSRF_HEADER]: CSRF_VALUE, origin: "http://127.0.0.1:7317" };
const RULES = "If Detroit wins, the market will resolve to Lions. If Buffalo wins, the market will resolve to Bills. If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, this market will resolve 50-50.";
const LIONS = { name: "Detroit Lions", abbreviation: "DET", league: "nfl", alias: "Lions" };
const BILLS = { name: "Buffalo Bills", abbreviation: "BUF", league: "nfl", alias: "Bills" };
const T = "2026-10-01T12:00:00Z";
const KEY = "11111111-2222-3333-4444-555555555555";
/** A 32-byte secret (what an Ed25519 key looks like) that must never appear in any output. */
const CANARY = crypto.randomBytes(32).toString("base64");

function usMoneyline(id: string, start: string): MarketSummary {
  return {
    provider: "polymarket_us", id, slug: `aec-nfl-det-buf-${id}`, url: `https://polymarket.us/event/nfl-det-buf-${id}`, question: `Detroit vs. Buffalo (${id})`, description: RULES,
    event: { id: `ev-${id}`, slug: `nfl-det-buf-${id}`, title: "DET Lions vs BUF Bills" },
    outcomes: [{ label: "Lions", tokenId: `aec-nfl-det-buf-${id}:YES`, price: 0.5 }, { label: "Bills", tokenId: `aec-nfl-det-buf-${id}:NO`, price: 0.5 }], endDate: start, active: true, closed: false, retrievedAt: "2026-09-16T00:00:00Z",
    constraints: { venue: "polymarket_us", slug: `aec-nfl-det-buf-${id}`, status: "MARKET_STATUS_OPEN", tickSize: "0.01", minQuantity: "1", feeCoefficient: "0.06", sides: [{ id: `${id}-l`, label: "Lions", long: true, team: LIONS }, { id: `${id}-b`, label: "Bills", long: false, team: BILLS }], category: "sports", sportsMarketType: "SPORTS_MARKET_TYPE_MONEYLINE", gameStartTime: start, eventStartTime: start, retrievedAt: "2026-09-16T00:00:00Z" },
  };
}

class FakeUs implements MarketProvider {
  readonly id = "polymarket_us" as const;
  byId = new Map<string, MarketSummary>();
  /** YES books per market slug (best bid / best ask). */
  books = new Map<string, { bid: number; ask: number }>();
  async search(): Promise<MarketSummary[]> { return []; }
  async get(idOrSlug: string): Promise<MarketSummary | undefined> { return this.byId.get(idOrSlug); }
  async list(): Promise<MarketSummary[]> { return []; }
  async book(tokenId: string): Promise<OrderBookSnapshot> {
    const slug = tokenId.replace(/:(YES|NO)$/, "");
    const b = this.books.get(slug) ?? { bid: 0.49, ask: 0.5 };
    return { provider: "polymarket_us", tokenId, bids: [{ price: b.bid, size: 500 }], asks: [{ price: b.ask, size: 500 }], retrievedAt: clock };
  }
  async priceHistory(): Promise<PricePoint[]> { return []; }
  async eventMarkets(): Promise<MarketSummary[]> { return []; }
}

class Faults implements FaultInjector {
  arm?: FaultPoint;
  hit: FaultPoint[] = [];
  at(point: FaultPoint): void {
    this.hit.push(point);
    if (this.arm === point) { this.arm = undefined; throw new Error(`injected crash at ${point}`); }
  }
}

let ctx: AppContext;
let app: ReturnType<typeof Fastify>;
let dataDir: string;
const fakeUs = new FakeUs();
const fake = new FakeTradingAdapter();
const faults = new Faults();
let clock = T;
let seq = 0;
let bindingId = "";

const A = { channelId: "UC-A", name: "Creator A" };
const B = { channelId: "UC-B", name: "Creator B" };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-execution-"));
  process.env.PL_DATA_DIR = dataDir;
  setMarketProviderForTests("polymarket_us", fakeUs);
  setTradingAdapterForTests(fake);
  fake.now = () => new Date(Date.parse(clock));
  const { createContext } = await import("../context.js");
  ctx = createContext({ now: () => new Date(Date.parse(clock)), faults, leaseHolder: "proc-1" });
  const s = ctx.settings.getPersisted();
  s.privacy.allowInternet = true;
  s.markets.venues = ["polymarket", "polymarket_us"];
  ctx.settings.savePersisted(s);
  app = Fastify();
  registerCsrfGuard(app, () => ["http://127.0.0.1:7317"]);
  registerDecisionRoutes(app, ctx);
  registerTradingRoutes(app, ctx);
  registerExecutionRoutes(app, ctx);
  registerContentRoutes(app, ctx);
  registerMarketRoutes(app, ctx);

  // Creator A: a usable history (four settled Lions picks at .25, three wins) so a forecast carries edge (same fixture as 1.12 F04).
  const games: [string, string, string, "Lions" | "Bills"][] = [["g01", "2026-09-01", "2026-08-31T23:00:00Z", "Lions"], ["g02", "2026-09-02", "2026-09-01T23:00:00Z", "Lions"], ["g03", "2026-09-03", "2026-09-02T23:00:00Z", "Lions"], ["g04", "2026-09-04", "2026-09-03T23:00:00Z", "Bills"]];
  for (const [id, day, priceAt, winner] of games) {
    const m = market(id, `${day}T17:00:00Z`, { yesPrice: 0.25, priceAt });
    claim(A, m.id, "Detroit Lions", day);
    resolve(id, winner, `${day}T21:00:00Z`);
  }
  // Creator B: four settled Bills picks at NO price .10 (YES .90), all wins — strong enough to carry pNo past .50 on the NO-side test.
  const bGames: [string, string, string][] = [["h01", "2026-09-01", "2026-08-31T23:00:00Z"], ["h02", "2026-09-02", "2026-09-01T23:00:00Z"], ["h03", "2026-09-03", "2026-09-02T23:00:00Z"], ["h04", "2026-09-04", "2026-09-03T23:00:00Z"]];
  for (const [id, day, priceAt] of bGames) {
    const m = market(id, `${day}T17:00:00Z`, { yesPrice: 0.9, priceAt });
    claim(B, m.id, "Buffalo Bills", day);
    resolve(id, "Bills", `${day}T21:00:00Z`);
  }

  // Account: connect the fake, widen the pilot limits for a multi-test session, sync, arm manual-live with the acknowledgement.
  fake.script(KEY, { secretKey: CANARY, balances: [fakeBalance("1000.00", "1000.00")] });
  bindingId = (await ctx.trading.connect({ keyId: KEY, secretKey: CANARY })).binding.id;
  ctx.trading.setLimits({ maxOpenMarkets: 50, totalOpenRisk: "1000", dailyCommitmentCap: "1000", perEvent: "100", dailyLossStop: "1000" }, { budgetTimezone: "UTC" });
  await ctx.trading.sync();
  assert.ok(ctx.lease.acquire(60_000), "this process holds the dispatch lease");
  await arm();
  await ctx.execution.startStream();
});
after(() => { ctx?.execution.stopStream(); ctx?.db.close(); delete process.env.PL_DATA_DIR; setMarketProviderForTests("polymarket_us", undefined); setTradingAdapterForTests(undefined); });

async function arm(): Promise<void> {
  await ctx.trading.sync();
  ctx.trading.setMode("manual_live", { acknowledge: LIVE_ACKNOWLEDGEMENT });
  assert.equal(ctx.trading.status().armed, true);
}

function market(id: string, start: string, opts: { yesPrice?: number; priceAt?: string } = {}) {
  const summary = usMoneyline(id, start);
  fakeUs.byId.set(id, summary);
  const m = ctx.markets.upsertFromSummary(summary, { snapshot: false });
  if (opts.priceAt) {
    const snap = ctx.markets.addSnapshot(m.id, { ...summary, outcomes: [{ label: "Lions", tokenId: `${summary.slug}:YES`, price: opts.yesPrice ?? 0.45 }, { label: "Bills", tokenId: `${summary.slug}:NO`, price: 1 - (opts.yesPrice ?? 0.45) }] }, "history");
    ctx.db.run("UPDATE market_snapshots SET retrieved_at = ? WHERE id = ?", opts.priceAt, snap.id);
  }
  return ctx.markets.get(m.id)!;
}

function resolve(id: string, outcome: "Lions" | "Bills" | "void", resolvedAt: string) {
  const prev = fakeUs.byId.get(id)!;
  const summary: MarketSummary = { ...prev, resolved: true, resolvedOutcome: outcome, closed: true, active: false, constraints: prev.constraints ? { ...prev.constraints, status: "MARKET_STATUS_RESOLVED" } : undefined };
  fakeUs.byId.set(id, summary);
  const m = ctx.markets.upsertFromSummary(summary, { snapshot: false });
  ctx.db.run("UPDATE markets SET resolved_at = ? WHERE id = ?", resolvedAt, m.id);
  return ctx.markets.get(m.id)!;
}

function claim(creator: { channelId: string; name: string }, marketId: string, team: "Detroit Lions" | "Buffalo Bills", publishedAt: string) {
  seq += 1;
  const id = `e${String(seq).padStart(4, "0")}${creator.channelId.slice(0, 3)}`;
  const video = ctx.videos.createFromYouTube({ youtubeId: id.padEnd(11, "x").slice(0, 11), url: `https://www.youtube.com/watch?v=${id}`, title: `${creator.name} picks`, publishedAt, channel: creator.name, channelId: creator.channelId, firstSeenAt: publishedAt.length > 10 ? publishedAt : `${publishedAt}T00:00:00.000Z` });
  ctx.videos.applyYouTubeInfo(video.id, { publishedPrecision: publishedAt.length > 10 ? "datetime" : "date" });
  const m = ctx.markets.get(marketId)!;
  const eventDate = (m.constraints?.gameStartTime ?? "2026-10-01").slice(0, 10);
  const p = ctx.predictions.create({ videoId: video.id, kind: "sports_pick", sportsPick: { sport: "NFL", league: "nfl", teams: ["Detroit Lions", "Buffalo Bills"], eventDate, pick: { type: "moneyline", team } }, quoteExact: `I like the ${team} tonight (${seq})`, normalizedStatement: `${team} win`, entities: ["Detroit Lions", "Buffalo Bills"], conditions: [], thresholds: [], madeOnDate: publishedAt.slice(0, 10), madeOnBasis: "publication", deadlineDate: eventDate, deadlineBasis: "rule:absolute", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: `${team} win` }] });
  const link = ctx.markets.propose({ predictionId: p.id, marketId: m.id, side: team === "Detroit Lions" ? "Lions" : "Bills", score: 1, relation: "exact", matchedBy: "rule:sports", status: "accepted" });
  const at = publishedAt.length > 10 ? publishedAt : `${publishedAt}T00:00:00.000Z`;
  ctx.db.run("UPDATE predictions SET created_at = ? WHERE id = ?", at, p.id);
  ctx.db.run("UPDATE prediction_market_links SET updated_at = ?, created_at = ? WHERE id = ?", at, at, link.id);
  const verification = ctx.contracts.verifyLink(link.id);
  assert.equal(verification.status, "verified_equivalent", `fixture must verify: ${verification.notes}`);
  ctx.db.run("UPDATE contract_verifications SET created_at = ? WHERE id = ?", at, verification.id);
  return { video, prediction: p, link, verification };
}

/** A fresh open market with a verified claim and a manual-live decision that needs review (the F0 of these tests). */
async function liveDecision(id: string, opts: { team?: "Detroit Lions" | "Buffalo Bills"; creator?: typeof A; book?: { bid: number; ask: number } } = {}): Promise<{ decision: TradeDecision; marketId: string; slug: string; claim: ReturnType<typeof claim> }> {
  const m = market(id, "2026-10-01T18:00:00Z");
  if (opts.book) fakeUs.books.set(m.constraints!.slug!, opts.book);
  const c = claim(opts.creator ?? A, m.id, opts.team ?? "Detroit Lions", "2026-09-30T10:00:00Z");
  const decision = await ctx.decisions.evaluate({ predictionId: c.prediction.id, linkId: c.link.id, now: clock, reuseForecast: false });
  assert.equal(decision.mode, "manual_live");
  assert.equal(decision.outcome, "needs_review", `${id}: ${JSON.stringify(decision.gates.filter((g) => !g.satisfied))}`);
  assert.ok(decision.sizing, "sized");
  return { decision, marketId: m.id, slug: m.constraints!.slug!, claim: c };
}

async function previewAndSubmit(decision: TradeDecision): Promise<TradeIntent> {
  const preview = await ctx.execution.preview(decision.id);
  return ctx.execution.submit(preview.id, { decisionHash: decision.rationaleHash });
}

const reservationOf = (intent: TradeIntent) => ctx.risk.get(intent.reservationId)!;
const openHolds = () => ctx.execution.holds(bindingId, true);
const exposure = () => ctx.risk.exposure(bindingId, clock.slice(0, 10));

// ------------------------------------------------------------------------------------------------------------------

test("E01 — preview shows the full rationale and cost and makes no create call; submit needs the unchanged decision hash; a paper-mode decision cannot be previewed", async () => {
  const { decision, slug } = await liveDecision("e01");
  const before = fake.createCalls;
  const preview = await ctx.execution.preview(decision.id);
  assert.equal(fake.createCalls, before, "preview never creates");
  assert.equal(fake.calls.filter((c) => c.method === "previewOrder").length, 1);
  const s = decision.sizing!;
  assert.deepEqual({ side: preview.display.side, quantity: preview.display.quantity, chosenCost: preview.display.chosenCost, yesWirePrice: preview.display.yesWirePrice, worstCost: preview.display.worstCost, feeBound: preview.display.feeBound, policyHash: preview.display.policyHash, evidenceUrl: preview.display.evidenceUrl },
    { side: "yes", quantity: s.quantity, chosenCost: s.limitCost, yesWirePrice: s.wirePrice, worstCost: s.worstCost, feeBound: s.feeBound, policyHash: ctx.trading.policy().policyHash, evidenceUrl: `/api/trading/decisions/${decision.id}/evidence` });
  assert.equal(s.wirePrice, "0.5", "YES buy: the wire price is the YES ask");
  assert.equal(s.quantity, "19", "$10 budget / (0.50 + 0.025 fee bound) → 19 contracts");
  assert.equal(preview.request.marketSlug, slug);
  assert.deepEqual({ intent: preview.request.intent, type: preview.request.type, tif: preview.request.tif, quantity: preview.request.quantity, price: preview.request.price, manual: preview.request.manualOrderIndicator }, { intent: "ORDER_INTENT_BUY_LONG", type: "ORDER_TYPE_LIMIT", tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL", quantity: 19, price: { value: "0.5", currency: "USD" }, manual: "MANUAL_ORDER_INDICATOR_MANUAL" });
  assert.ok(Date.parse(preview.expiresAt) - Date.parse(clock) === 60_000);
  // The wrong hash cannot execute — through the service and through the route.
  await assert.rejects(() => ctx.execution.submit(preview.id, { decisionHash: "0".repeat(64) }), (e: unknown) => e instanceof ExecutionError && e.code === "hash_mismatch");
  const bad = await app.inject({ method: "POST", url: `/api/trading/decisions/${decision.id}/submit`, headers: csrf, payload: { previewId: preview.id, decisionHash: "f".repeat(64) } });
  assert.equal(bad.statusCode, 409);
  assert.equal(bad.json().error, "hash_mismatch");
  const smuggle = await app.inject({ method: "POST", url: `/api/trading/decisions/${decision.id}/submit`, headers: csrf, payload: { previewId: preview.id, decisionHash: decision.rationaleHash, quantity: "500" } });
  assert.equal(smuggle.statusCode, 400, "strict body: no quantity/price/side from a client");
  assert.equal(fake.createCalls, before, "nothing sent yet");
  // The right hash: one create call, an id is acceptance, the fake fills in full.
  const ok = await app.inject({ method: "POST", url: `/api/trading/decisions/${decision.id}/submit`, headers: csrf, payload: { previewId: preview.id, decisionHash: decision.rationaleHash } });
  assert.equal(ok.statusCode, 201, ok.body);
  const intent = ok.json() as TradeIntent;
  assert.equal(fake.createCalls, before + 1);
  assert.equal(intent.state, "filled");
  assert.equal(intent.filledQuantity, "19");
  assert.equal(intent.order?.state, "filled");
  assert.equal(intent.venueOrderId, intent.order?.id);
  assert.equal(reservationOf(intent).state, "consumed");
  assert.equal(reservationOf(intent).filledAmount, D("19").mul("0.5").toString(), "consumed = filled × chosen cost (+ 0 fees on this fixture)");
  assert.equal(ctx.execution.getPreview(preview.id)?.consumedBy, "submit");
  // A decision evaluated in paper mode is not a live rationale.
  ctx.trading.setMode("paper");
  const m2 = market("e01p", "2026-10-01T18:00:00Z");
  const c2 = claim(A, m2.id, "Detroit Lions", "2026-09-30T10:00:00Z");
  const paperDecision = await ctx.decisions.evaluate({ predictionId: c2.prediction.id, linkId: c2.link.id, now: clock, dispatch: false });
  await arm();
  await assert.rejects(() => ctx.execution.preview(paperDecision.id), (e: unknown) => e instanceof ExecutionError && e.code === "decision_not_live");
  assert.equal(fake.createCalls, before + 1);
});

test("E02 — a changed price, a changed account, a policy edit or an expired preview invalidates the preview; the old hash cannot execute", async () => {
  // Price moved: the fresh re-decision sizes differently → preview_stale, preview consumed, nothing sent.
  const p1 = await liveDecision("e02a");
  const pv1 = await ctx.execution.preview(p1.decision.id);
  fakeUs.books.set(p1.slug, { bid: 0.54, ask: 0.55 });
  const before = fake.createCalls;
  await assert.rejects(() => ctx.execution.submit(pv1.id, { decisionHash: p1.decision.rationaleHash }), (e: unknown) => e instanceof ExecutionError && e.code === "preview_stale");
  assert.equal(ctx.execution.getPreview(pv1.id)?.consumedBy, "stale");
  assert.equal(fake.createCalls, before);
  assert.equal(ctx.execution.intents({ bindingId, mode: "live" }).filter((i) => i.decisionId === p1.decision.id).length, 0, "no intent, no reservation");
  // Same decision, price restored: a NEW preview is needed (the consumed one stays consumed).
  fakeUs.books.set(p1.slug, { bid: 0.49, ask: 0.5 });
  await assert.rejects(() => ctx.execution.submit(pv1.id, { decisionHash: p1.decision.rationaleHash }), (e: unknown) => e instanceof ExecutionError && e.code === "preview_consumed");
  // Account changed: buying power collapses before confirmation.
  const p2 = await liveDecision("e02b");
  const pv2 = await ctx.execution.preview(p2.decision.id);
  fake.setBalance("1.00");
  clock = "2026-10-01T12:00:40Z"; // sync is now stale → submit re-syncs and sees $1
  await assert.rejects(() => ctx.execution.submit(pv2.id, { decisionHash: p2.decision.rationaleHash }), (e: unknown) => e instanceof ExecutionError && e.code === "preview_stale");
  fake.setBalance("1000.00");
  ctx.db.run("DELETE FROM trading_account_syncs WHERE at > ?", T); // fixture hygiene: the clock goes back to T
  clock = T;
  await ctx.trading.sync();
  // Policy edit: limits change disarms (1.12 rule); after re-arming, the old preview's policy hash no longer matches.
  const p3 = await liveDecision("e02c");
  const pv3 = await ctx.execution.preview(p3.decision.id);
  ctx.trading.setLimits({ orderBudget: "9" });
  assert.equal(ctx.trading.policy().mode, "paper", "a limits change disarms");
  await assert.rejects(() => ctx.execution.submit(pv3.id, { decisionHash: p3.decision.rationaleHash }), (e: unknown) => e instanceof ExecutionError && e.code === "mode_not_live");
  await arm();
  await assert.rejects(() => ctx.execution.submit(pv3.id, { decisionHash: p3.decision.rationaleHash }), (e: unknown) => e instanceof ExecutionError && e.code === "preview_stale");
  ctx.trading.setLimits({ orderBudget: "10" });
  await arm();
  // Expiry: 60 s TTL.
  const p4 = await liveDecision("e02d");
  const pv4 = await ctx.execution.preview(p4.decision.id);
  clock = "2026-10-01T12:01:01Z";
  await assert.rejects(() => ctx.execution.submit(pv4.id, { decisionHash: p4.decision.rationaleHash }), (e: unknown) => e instanceof ExecutionError && e.code === "preview_expired");
  clock = T;
  await ctx.trading.sync();
  assert.equal(fake.createCalls, before, "none of the stale paths sent anything");
});

test("E03 — NO with a chosen-side limit of .40 goes to the wire as YES .60 and BUY_SHORT, sized on the .40 risk; YES round-trips unchanged; no double inversion anywhere", async () => {
  // Book: YES bid .60 / ask .61 → the NO cost is 1 − .60 = .40; Creator B's Bills record gives pNo the edge.
  const { decision, slug } = await liveDecision("e03", { team: "Buffalo Bills", creator: B, book: { bid: 0.6, ask: 0.61 } });
  const s = decision.sizing!;
  assert.equal(s.side, "no");
  assert.equal(s.limitCost, "0.4", "chosen-side (NO) cost");
  assert.equal(s.wirePrice, "0.6", "converted once by the decision: YES = 1 − .40");
  assert.equal(s.quantity, "23", "$10 / (.40 + per-contract fee bound .0244 = .06 × .60 × .40 + .01) = 23.56 → 23 contracts: sized on the NO risk, not on .60");
  assert.equal(s.feeBound, "0.57", "23 × .0244 = .5612, rounded up to the cent");
  assert.equal(s.worstCost, D("23").mul("0.4").add("0.57").toString(), "worst cost = quantity × NO cost + fee bound = 9.77 ≤ $10");
  assert.ok(D(s.worstCost).lte("10"));
  const preview = await ctx.execution.preview(decision.id);
  assert.deepEqual({ intent: preview.request.intent, price: preview.request.price }, { intent: "ORDER_INTENT_BUY_SHORT", price: { value: "0.6", currency: "USD" } });
  const intent = await ctx.execution.submit(preview.id, { decisionHash: decision.rationaleHash });
  const call = fake.calls.filter((c) => c.method === "createOrder").at(-1)!;
  assert.deepEqual({ slug: call.args?.marketSlug, side: call.args?.side, yesPrice: call.args?.yesPrice, quantity: call.args?.quantity }, { slug, side: "no", yesPrice: "0.6", quantity: s.quantity });
  assert.equal(intent.state, "filled");
  assert.equal(intent.order?.yesPrice, "0.6");
  assert.equal(intent.executions?.find((e) => e.type === "fill")?.chosenCost, "0.4", "fills are recorded at the chosen-side cost (1 − YES)");
  assert.equal(reservationOf(intent).filledAmount, D(s.quantity).mul("0.4").toString());
  assert.equal(ctx.execution.positions(bindingId).find((p) => p.marketSlug === slug)?.localNet, D(s.quantity).neg().toString(), "a NO position is a negative YES-denominated net");
});

test("E04 — a double-click, concurrent API calls and a repeated submit produce one intent, one reservation and one create call; duplicates return the same intent", async () => {
  const { decision, marketId } = await liveDecision("e04");
  const preview = await ctx.execution.preview(decision.id);
  const before = fake.createCalls;
  const results = await Promise.allSettled([
    ctx.execution.submit(preview.id, { decisionHash: decision.rationaleHash }),
    ctx.execution.submit(preview.id, { decisionHash: decision.rationaleHash }),
    app.inject({ method: "POST", url: `/api/trading/decisions/${decision.id}/submit`, headers: csrf, payload: { previewId: preview.id, decisionHash: decision.rationaleHash } }).then((r) => {
      const body = r.json() as TradeIntent & { error?: string };
      if (r.statusCode === 201) return body;
      throw new ExecutionError(body.error ?? "", body.error ?? "route_error", r.statusCode);
    }),
  ]);
  const ids = new Set<string>();
  for (const r of results) {
    if (r.status === "fulfilled") ids.add((r.value as TradeIntent).id);
    else assert.ok(r.reason instanceof ExecutionError && ["preview_consumed", "preview_stale"].includes(r.reason.code), `a loser is told the preview is spent, never re-sent: ${String(r.reason)}`);
  }
  assert.equal(ids.size, 1, "exactly one intent id among the winners");
  assert.ok(results.some((r) => r.status === "fulfilled"));
  assert.equal(fake.createCalls, before + 1, "exactly one venue create call");
  const m = ctx.markets.get(marketId)!;
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE decision_id = ?", decision.id)!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM risk_reservations WHERE decision_id = ?", decision.id)!.n, 1);
  // A later re-delivery of the same decision (a restarted job, another preview) returns the existing intent and sends nothing.
  const again = await ctx.execution.preview(decision.id).catch((e: ExecutionError) => e);
  assert.ok(again instanceof ExecutionError && again.code === "decision_not_eligible", "the opportunity is consumed: a fresh re-decision skips");
  const same = await ctx.execution.submit(preview.id, { decisionHash: decision.rationaleHash });
  assert.equal(same.id, [...ids][0]);
  assert.equal(fake.createCalls, before + 1);
  assert.equal(ctx.risk.opportunityConsumed(bindingId, "polymarket_us", m.venueId)?.intentId, same.id);
});

test("E05 — a dropped POST response and a timeout before acceptance both become submission_unknown: reservation kept, dispatch paused, zero resends; the owner resolves each explicitly", async () => {
  // Variant 1: the venue creates and fills the order but the response is lost.
  const v1 = await liveDecision("e05a");
  fake.behave(v1.slug, { mode: "drop_response", feePerContract: "0.02" });
  const before = fake.createCalls;
  const i1 = await previewAndSubmit(v1.decision);
  assert.equal(i1.state, "submission_unknown");
  assert.ok(i1.dispatchMarkerAt && i1.submittedAt, "the marker was committed before the POST");
  assert.equal(i1.venueOrderId, undefined, "no id was ever received");
  assert.equal(reservationOf(i1).state, "reserved", "risk capacity is held");
  assert.equal(fake.createCalls, before + 1);
  const st = ctx.trading.status();
  assert.equal(st.submissionAvailable, false);
  assert.ok(st.dispatchBlockers.some((b) => /paused/.test(b)) && st.dispatchBlockers.some((b) => /unknown outcome/.test(b)), st.dispatchBlockers.join("; "));
  assert.equal(openHolds().filter((h) => h.kind === "submission_unknown" && h.subject === i1.id).length, 1);
  // Nothing resends: the same decision, another decision, a reconcile, a restart.
  const again = await ctx.execution.submit(i1.previewId!, { decisionHash: v1.decision.rationaleHash });
  assert.equal(again.id, i1.id);
  const other = await liveDecision("e05x").catch((e: Error) => e);
  if (!(other instanceof Error)) await assert.rejects(() => ctx.execution.preview(other.decision.id), (e: unknown) => e instanceof ExecutionError && e.code === "dispatch_blocked");
  const report = await ctx.execution.reconcile();
  assert.equal(fake.createCalls, before + 1, "reconcile never resends");
  assert.equal(report.paused, true);
  assert.equal(report.unknownIntents.length, 1);
  assert.equal(report.unknownIntents[0].candidates.length, 1, "the venue's order (external until proven ours) is listed as a candidate, not linked");
  assert.equal(ctx.execution.intent(i1.id)?.state, "submission_unknown");
  assert.equal(ctx.execution.order(report.unknownIntents[0].candidates[0])?.external, true);
  assert.equal(ctx.execution.recoverAfterCrash().unknown.length, 0, "already unknown; recovery adds nothing and sends nothing");
  // Owner links the candidate after checking the venue: the order becomes ours, fills settle the reservation once.
  const linked = ctx.execution.resolveUnknown(i1.id, { venueOrderId: report.unknownIntents[0].candidates[0] }, "checked on polymarket.us: this is my order");
  assert.equal(linked.state, "filled");
  assert.equal(linked.filledQuantity, "19");
  assert.equal(reservationOf(linked).state, "consumed");
  assert.equal(reservationOf(linked).filledAmount, D("19").mul("0.52").toString(), "19 × (.50 + .02 fee)");
  assert.equal(openHolds().length, 0);
  assert.equal(ctx.trading.status().submissionAvailable, true, "pause lifted once nothing is unresolved");
  // Variant 2: timeout before anything was created (still ambiguous from here: 408 does not prove the venue never saw it).
  const v2 = await liveDecision("e05b");
  fake.behave(v2.slug, { mode: "timeout" });
  const i2 = await previewAndSubmit(v2.decision);
  assert.equal(i2.state, "submission_unknown");
  assert.equal(reservationOf(i2).state, "reserved");
  assert.equal(fake.createCalls, before + 2);
  const r2 = await ctx.execution.reconcile();
  assert.deepEqual(r2.unknownIntents, [{ intentId: i2.id, candidates: [] }], "absence from one query is not permission to resend");
  assert.equal(ctx.execution.intent(i2.id)?.state, "submission_unknown", "not auto-rejected either");
  const cleared = ctx.execution.resolveUnknown(i2.id, { outcome: "not_submitted" }, "venue order history shows nothing for this market");
  assert.equal(cleared.state, "rejected_local");
  assert.equal(reservationOf(cleared).state, "released");
  assert.equal(ctx.risk.opportunityConsumed(bindingId, "polymarket_us", ctx.markets.get(v2.marketId)!.venueId), undefined, "opportunity given back only after the explicit resolution");
  assert.equal(ctx.trading.status().submissionAvailable, true);
  assert.equal(fake.createCalls, before + 2);
});

test("E06 — crashes before reserve, after reserve, after the marker and after the POST: rollback or provable unsent work; marker variants reconcile without resend", async () => {
  const before = fake.createCalls;
  // 1. before_reserve: nothing persisted, preview reusable.
  const a = await liveDecision("e06a");
  const pa = await ctx.execution.preview(a.decision.id);
  faults.arm = "before_reserve";
  await assert.rejects(() => ctx.execution.submit(pa.id, { decisionHash: a.decision.rationaleHash }), /injected crash at before_reserve/);
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE decision_id = ?", a.decision.id)!.n, 0);
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM risk_reservations WHERE decision_id = ?", a.decision.id)!.n, 0);
  assert.equal(ctx.execution.getPreview(pa.id)?.consumedAt, undefined);
  assert.equal(fake.createCalls, before);
  // 2. after_reserve (before the marker): the intent is provably unsent → recovery expires it and releases capacity.
  const b = await liveDecision("e06b");
  const pb = await ctx.execution.preview(b.decision.id);
  faults.arm = "after_reserve";
  await assert.rejects(() => ctx.execution.submit(pb.id, { decisionHash: b.decision.rationaleHash }), /injected crash at after_reserve/);
  const ib = ctx.execution.intents({ bindingId, mode: "live" }).find((i) => i.decisionId === b.decision.id)!;
  assert.equal(ib.state, "reserved");
  assert.equal(ib.dispatchMarkerAt, undefined);
  const rec = ctx.execution.recoverAfterCrash();
  assert.deepEqual(rec, { expired: [ib.id], unknown: [] });
  assert.equal(ctx.execution.intent(ib.id)?.state, "expired");
  assert.equal(reservationOf(ib).state, "released");
  assert.equal(ctx.risk.opportunityConsumed(bindingId, "polymarket_us", ctx.markets.get(b.marketId)!.venueId), undefined, "never sent → the opportunity is free again");
  assert.equal(fake.createCalls, before);
  // 3. after_marker (before the POST): the venue may hold it → unknown, held, paused; reconcile finds no order; owner clears it.
  const c = await liveDecision("e06c");
  const pc = await ctx.execution.preview(c.decision.id);
  faults.arm = "after_marker";
  await assert.rejects(() => ctx.execution.submit(pc.id, { decisionHash: c.decision.rationaleHash }), /injected crash at after_marker/);
  const ic = ctx.execution.intents({ bindingId, mode: "live" }).find((i) => i.decisionId === c.decision.id)!;
  assert.equal(ic.state, "submitting");
  assert.ok(ic.dispatchMarkerAt);
  assert.deepEqual(ctx.execution.recoverAfterCrash(), { expired: [], unknown: [ic.id] });
  assert.equal(ctx.execution.intent(ic.id)?.state, "submission_unknown");
  assert.equal(reservationOf(ic).state, "reserved");
  assert.equal(fake.createCalls, before, "no POST happened and none is made now");
  const rc = await ctx.execution.reconcile();
  assert.deepEqual(rc.unknownIntents, [{ intentId: ic.id, candidates: [] }]);
  ctx.execution.resolveUnknown(ic.id, { outcome: "not_submitted" }, "crash drill: the venue shows no order");
  // 4. after_post (response received, persistence lost): the venue holds a filled order; recovery marks unknown; reconcile lists the candidate; owner links it.
  const d = await liveDecision("e06d");
  const pd = await ctx.execution.preview(d.decision.id);
  faults.arm = "after_post";
  await assert.rejects(() => ctx.execution.submit(pd.id, { decisionHash: d.decision.rationaleHash }), /injected crash at after_post/);
  assert.equal(fake.createCalls, before + 1);
  const idd = ctx.execution.intents({ bindingId, mode: "live" }).find((i) => i.decisionId === d.decision.id)!;
  assert.equal(idd.state, "submitting");
  assert.deepEqual(ctx.execution.recoverAfterCrash().unknown, [idd.id]);
  const rd = await ctx.execution.reconcile();
  assert.equal(fake.createCalls, before + 1, "no double order");
  assert.equal(rd.unknownIntents[0].candidates.length, 1);
  const done = ctx.execution.resolveUnknown(idd.id, { venueOrderId: rd.unknownIntents[0].candidates[0] }, "matches the venue's order page");
  assert.equal(done.state, "filled");
  assert.equal(reservationOf(done).state, "consumed");
  assert.equal(openHolds().length, 0);
  assert.equal(ctx.trading.status().submissionAvailable, true);
});

test("E07 — an unknown submission that resembles an external manual order is never auto-linked; the account stays paused until the owner decides", async () => {
  const v = await liveDecision("e07");
  // An external (manual) order with the same look exists from a minute earlier; then our POST loses its response.
  const ext = fake.externalOrder(v.slug, "yes", "19", "0.5", { fill: true, createTime: "2026-10-01T11:59:00Z" });
  fake.behave(v.slug, { mode: "drop_response" });
  const i = await previewAndSubmit(v.decision);
  assert.equal(i.state, "submission_unknown");
  const r = await ctx.execution.reconcile();
  const u = r.unknownIntents.find((x) => x.intentId === i.id)!;
  assert.equal(u.candidates.length, 2, "both same-looking orders are candidates");
  assert.ok(u.candidates.includes(ext.id));
  assert.equal(ctx.execution.intent(i.id)?.state, "submission_unknown", "no guessed association");
  assert.equal(ctx.execution.intent(i.id)?.venueOrderId, undefined);
  assert.equal(reservationOf(i).state, "reserved", "no premature release");
  assert.equal(ctx.trading.status().submissionAvailable, false, "paused for resolution");
  const hold = openHolds().find((h) => h.subject === i.id)!;
  assert.ok(/not proof of identity/.test(String(hold.detail.note)));
  // Both orders reached us on the private stream, so the venue position (38) is already accounted for: no discrepancy is invented.
  assert.equal(r.discrepancies.filter((d) => d.marketSlug === v.slug).length, 0);
  // Owner picks the app's order (the later one), explicitly.
  const ours = u.candidates.find((c) => c !== ext.id)!;
  ctx.execution.resolveUnknown(i.id, { venueOrderId: ours }, "the venue's order page shows two orders; the 12:00 one is the app's");
  assert.equal(ctx.execution.intent(i.id)?.state, "filled");
  assert.equal(ctx.execution.order(ext.id)?.external, true, "the manual order stays external, with no invented rationale");
  const r2 = await ctx.execution.reconcile();
  assert.equal(r2.discrepancies.length, 0, "ours + the labelled external order account for the venue position");
  for (const h of openHolds()) ctx.execution.resolveHold(h.id, "reviewed after linking");
  assert.equal(ctx.trading.status().submissionAvailable, true);
});

test("E08 — the venue returns an id and then a rejected event: rejected with reason, no fill, no position, reservation released once", async () => {
  const v = await liveDecision("e08");
  fake.behave(v.slug, { mode: "reject", rejectReason: "ORD_REJECT_REASON_INSUFFICIENT_FUNDS" });
  const i = await previewAndSubmit(v.decision);
  assert.equal(i.state, "rejected");
  assert.equal(i.order?.state, "rejected");
  assert.equal(i.order?.rejectReason, "ORD_REJECT_REASON_INSUFFICIENT_FUNDS");
  assert.equal(i.filledQuantity, "0");
  assert.equal(i.executions?.filter((e) => e.type === "fill" || e.type === "partial_fill").length, 0);
  assert.equal(reservationOf(i).state, "released");
  assert.equal(ctx.execution.positions(bindingId).find((p) => p.marketSlug === v.slug), undefined);
  assert.equal(exposure().perMarket[ctx.markets.get(v.marketId)!.venueId] ?? "0", "0");
  // The opportunity stays consumed: a venue rejection is not an invitation to retry the IOC.
  assert.ok(ctx.risk.opportunityConsumed(bindingId, "polymarket_us", ctx.markets.get(v.marketId)!.venueId));
});

test("E09 — ten fills then an IOC cancel of the remainder, delivered twice with a stale open snapshot last: filled 10, cost $5.20, one release, position stays open, no regression", async () => {
  const v = await liveDecision("e09");
  fake.behave(v.slug, { mode: "partial", fills: Array.from({ length: 10 }, () => ({ quantity: "1", yesPrice: "0.5" })), feePerContract: "0.02" });
  fake.streamDuplicates = 2;
  const i = await previewAndSubmit(v.decision);
  fake.streamDuplicates = 1;
  assert.equal(i.state, "partially_filled");
  assert.equal(i.filledQuantity, "10");
  assert.equal(i.order?.state, "canceled");
  assert.equal(i.order?.filledQuantity, "10");
  assert.equal(i.order?.fees, "0.2");
  const fills = i.executions!.filter((e) => e.type === "partial_fill" || e.type === "fill");
  assert.equal(fills.length, 10, "duplicates deduplicated by execution id / trade id");
  assert.equal(i.executions!.filter((e) => e.type === "canceled").length, 1);
  const res = reservationOf(i);
  assert.equal(res.state, "consumed");
  assert.equal(res.filledAmount, "5.2", "10 × .50 + 10 × .02");
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM risk_reservations WHERE id = ? AND released_at IS NOT NULL", res.id)!.n, 1, "released exactly once");
  // Stale "open" snapshot arrives last (out of order) — forward-only: still canceled with 10 filled.
  const venueOrder = fake.orders.get(i.venueOrderId!)!;
  ctx.execution.applyOrderSnapshot(bindingId, { ...fake.snapshot(venueOrder), state: "open", stateRaw: "ORDER_STATE_NEW", filledQuantity: "3" }, "stream");
  const after = ctx.execution.order(i.venueOrderId!)!;
  assert.equal(after.state, "canceled");
  assert.equal(after.filledQuantity, "10");
  assert.equal(ctx.execution.intent(i.id)?.state, "partially_filled");
  // The position is open although the order is canceled; exposure counts the consumed amount.
  const pos = ctx.execution.positions(bindingId).find((p) => p.marketSlug === v.slug)!;
  assert.equal(pos.localNet, "10");
  assert.equal(pos.discrepancy, undefined);
  const venueId = ctx.markets.get(v.marketId)!.venueId;
  assert.equal(exposure().perMarket[venueId], "5.2");
  // Re-delivering every past execution again changes nothing.
  for (const ex of venueOrder.executions) fake.redeliver(ex);
  assert.equal(ctx.execution.executions(i.venueOrderId!).length, i.executions!.length);
  assert.equal(reservationOf(i).filledAmount, "5.2");
});

test("E10 — a cancel requested while the final fill arrives counts the fill and reports the cancel truthfully; a reconnect midway through a paged snapshot completes and deduplicates", async () => {
  const v = await liveDecision("e10");
  fake.behave(v.slug, { mode: "rest" }); // acknowledged, unprocessed
  const i = await previewAndSubmit(v.decision);
  assert.equal(i.state, "acknowledged");
  assert.equal(i.order?.state, "open");
  // The venue fills 4 contracts in the same instant the cancel lands, then cancels the rest.
  const venueOrder = fake.orders.get(i.venueOrderId!)!;
  const scriptedCancel = fake.script(KEY, { secretKey: CANARY, balances: [fakeBalance("1000.00", "1000.00")], cancel: (id) => { fake.fill(venueOrder, "4", "0.5", "0.02"); fake.applyCancel(venueOrder, "requested by the app"); return { orderId: id, outcome: "requested" as const }; } });
  const c = await ctx.execution.cancelIntent(i.id);
  assert.equal(c.outcome, "requested");
  scriptedCancel.script(KEY, { secretKey: CANARY, balances: [fakeBalance("1000.00", "1000.00")] });
  const after = ctx.execution.intent(i.id)!;
  assert.equal(after.state, "partially_filled");
  assert.equal(after.filledQuantity, "4");
  assert.equal(after.order?.state, "canceled");
  assert.ok(after.order?.cancelRequestedAt);
  assert.equal(reservationOf(after).filledAmount, D("4").mul("0.52").toString());
  assert.equal(ctx.execution.positions(bindingId).find((p) => p.marketSlug === v.slug)?.localNet, "4");
  // A paged activities snapshot with a connection reset on page 2: read to the end, retried once, no duplicates.
  fake.activityPageSize = 1;
  fake.failNextActivityPage = true;
  const before = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM executions")!.n;
  const callsBefore = fake.calls.length;
  const r = await ctx.execution.reconcile();
  fake.activityPageSize = 100;
  assert.equal(r.activitiesRead, fake.activitiesLedger.length, "every page was read");
  const pageCalls = fake.calls.slice(callsBefore).filter((c) => c.method === "activities");
  assert.equal(pageCalls.length, fake.activitiesLedger.length + 1, "one page per activity, plus the one retry of the page that reset");
  assert.equal(pageCalls[1].args?.cursor, pageCalls[2].args?.cursor, "the retry re-reads the same cursor: nothing skipped, nothing doubled");
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM executions")!.n, before, "activities already known from the stream add nothing");
  assert.equal(r.discrepancies.length, 0);
  assert.equal(ctx.execution.positions(bindingId).find((p) => p.marketSlug === v.slug)?.localNet, "4");
});

test("E11 — dropped stream events are recovered from REST: fills, fees and balance follow the venue; an external exit opens a discrepancy hold that pauses trading; nothing is duplicated", async () => {
  const v = await liveDecision("e11");
  fake.behave(v.slug, { mode: "partial", fills: [{ quantity: "5", yesPrice: "0.5" }, { quantity: "5", yesPrice: "0.49" }], feePerContract: "0.02" });
  fake.dropStream = true;
  const i = await previewAndSubmit(v.decision);
  // The create response carried the id; the stream lost every execution; the immediate read-back is what we know.
  const known = ctx.execution.intent(i.id)!;
  assert.ok(["acknowledged", "partially_filled"].includes(known.state));
  fake.setBalance("994.80"); // 10 contracts: 5 × .50 + 5 × .49 + .20 fees = 5.15 … the venue says what it says
  fake.dropStream = false;
  const r = await ctx.execution.reconcile();
  const after = ctx.execution.intent(i.id)!;
  assert.equal(after.state, "partially_filled");
  assert.equal(after.filledQuantity, "10");
  assert.equal(after.order?.fees, "0.2");
  assert.equal(after.order?.avgPrice, "0.495");
  assert.equal(after.executions!.filter((e) => e.type === "partial_fill" || e.type === "fill").length, 2, `REST snapshot + activities → two fills, once each: ${JSON.stringify(after.executions!.map((e) => ({ id: e.id, t: e.type, q: e.quantity, src: e.source, trade: e.tradeId })))}`);
  assert.equal(reservationOf(after).filledAmount, D("5").mul("0.5").add(D("5").mul("0.49")).add("0.2").toString());
  assert.equal(ctx.trading.latestSync(bindingId, true)?.balances[0].buyingPower?.value, "994.80", "balance follows the venue");
  assert.equal(r.discrepancies.length, 0);
  // Replaying the dropped stream events now: every fill is a duplicate (matched by trade id); only the lifecycle
  // events REST could not supply (new, canceled) are added, and nothing about quantities or money changes.
  const fillsBefore = ctx.execution.executions(i.venueOrderId!).filter((e) => e.type === "partial_fill" || e.type === "fill").length;
  for (const e of fake.flushDropped()) if (e.kind === "execution") ctx.execution.applyExecution(bindingId, e.execution, "stream");
  const replayed = ctx.execution.executions(i.venueOrderId!);
  assert.equal(replayed.filter((e) => e.type === "partial_fill" || e.type === "fill").length, fillsBefore);
  assert.deepEqual(replayed.filter((e) => e.source === "stream").map((e) => e.type).sort(), ["canceled", "new"]);
  assert.equal(ctx.execution.intent(i.id)?.filledQuantity, "10");
  assert.equal(reservationOf(after).filledAmount, "5.15");
  // An external exit (a manual sell of 6) makes the venue position 4 while our records say 10 → discrepancy → paused.
  fake.externalExit(v.slug, "6");
  const r2 = await ctx.execution.reconcile();
  const disc = r2.discrepancies.find((d) => d.marketSlug === v.slug)!;
  assert.deepEqual({ venue: disc.venueNet, local: disc.localNet }, { venue: "4", local: "10" });
  assert.equal(ctx.trading.status().submissionAvailable, false);
  const hold = openHolds().find((h) => h.kind === "discrepancy" && h.subject === v.slug)!;
  assert.ok(hold);
  assert.equal(ctx.execution.intent(i.id)?.filledQuantity, "10", "our fills are not rewritten to match");
  ctx.execution.resolveHold(hold.id, "sold 6 manually on the venue");
  assert.equal(ctx.trading.status().submissionAvailable, true);
  fake.externalPositionAdjustments.delete(v.slug);
});

test("E12 — only official account activity settles a live position: win, loss, void and a correction are separate events; a .99 quote or a ledger verdict settles nothing", async () => {
  const win = await liveDecision("e12w");
  const iw = await previewAndSubmit(win.decision);
  assert.equal(iw.state, "filled");
  // A price of .99 on the market and a research/ledger verdict must not settle the live position.
  fakeUs.books.set(win.slug, { bid: 0.98, ask: 0.99 });
  ctx.markets.addSnapshot(win.marketId, { ...fakeUs.byId.get("e12w")!, outcomes: [{ label: "Lions", tokenId: `${win.slug}:YES`, price: 0.99 }, { label: "Bills", tokenId: `${win.slug}:NO`, price: 0.01 }] }, "clob");
  assert.equal(ctx.execution.positions(bindingId).find((p) => p.marketSlug === win.slug)?.settled, undefined);
  // The paper path observes a venue resolution status: it settles PAPER positions and must leave the live records alone.
  resolve("e12w", "Lions", "2026-10-01T22:00:00Z");
  ctx.decisions.settleResolved(win.marketId, "2026-10-01T22:05:00Z");
  const winVenueId = ctx.markets.get(win.marketId)!.venueId;
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM settlement_events WHERE venue_market_id = ?", winVenueId)!.n, 1, "the paper path recorded its market-status event");
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM settlement_events WHERE venue_market_id = ? AND binding_id IS NOT NULL", winVenueId)!.n, 0, "market-status settlement carries no live lineage");
  assert.equal(ctx.execution.positions(bindingId).find((p) => p.marketSlug === win.slug)?.settled, undefined, "live position still open until official activity");
  assert.equal(ctx.risk.get(iw.reservationId)?.state, "consumed");
  // Official resolution activity: win → +quantity − cost − fees.
  fake.settle(win.slug, "yes");
  const r = await ctx.execution.reconcile();
  assert.equal(r.settlements, 2, "one market-level event + one per-intent event");
  const ev = ctx.execution.settlements().find((e) => e.intentId === iw.id)!;
  assert.deepEqual({ kind: ev.kind, outcome: ev.outcome, source: ev.source, amount: ev.amount }, { kind: "resolved", outcome: "yes", source: "account_activity", amount: D("19").sub(D("19").mul("0.5")).toString() });
  assert.equal(ctx.execution.positions(bindingId).find((p) => p.marketSlug === win.slug)?.settled?.outcome, "win");
  const decisionAfter = ctx.decisions.get(win.decision.id)!;
  assert.equal(decisionAfter.rationaleHash, win.decision.rationaleHash, "settlement never rewrites the decision");
  // Loss.
  const loss = await liveDecision("e12l");
  const il = await previewAndSubmit(loss.decision);
  fake.settle(loss.slug, "no");
  await ctx.execution.reconcile();
  const evl = ctx.execution.settlements().find((e) => e.intentId === il.id)!;
  assert.equal(evl.amount, D("19").mul("0.5").neg().toString());
  assert.equal(ctx.execution.positions(bindingId).find((p) => p.marketSlug === loss.slug)?.settled?.outcome, "loss");
  // Today's realized loss is net of the day's official settlements (+9.5 win, −9.5 loss → 0), never a research verdict or a quote.
  const todays = ctx.execution.settlements().filter((e) => e.intentId && e.amount && e.observedAt.startsWith(clock.slice(0, 10)));
  const net = todays.reduce((acc, e) => acc.add(e.amount!), D("0"));
  assert.equal(exposure().dailyRealizedLoss, net.isNeg() ? net.neg().toString() : "0");
  assert.deepEqual(todays.map((e) => e.amount).sort(), ["-9.5", "9.5"]);
  // Void / refund.
  const voided = await liveDecision("e12v");
  const iv = await previewAndSubmit(voided.decision);
  fake.settle(voided.slug, "void");
  await ctx.execution.reconcile();
  const evv = ctx.execution.settlements().find((e) => e.intentId === iv.id)!;
  assert.deepEqual({ kind: evv.kind, amount: evv.amount }, { kind: "void", amount: "0" });
  assert.equal(ctx.execution.positions(bindingId).find((p) => p.marketSlug === voided.slug)?.settled?.outcome, "void");
  // A correction after the win: a NEW event; the first event and the decision stay as they were.
  fake.settle(win.slug, "no", { correction: true });
  await ctx.execution.reconcile();
  const events = ctx.execution.settlements().filter((e) => e.venueMarketId === winVenueId && e.intentId === iw.id);
  assert.deepEqual(events.map((e) => e.kind).sort(), ["correction", "resolved"]);
  assert.equal(events.find((e) => e.kind === "resolved")?.amount, ev.amount);
  assert.equal(ctx.decisions.get(win.decision.id)!.rationaleHash, win.decision.rationaleHash);
  assert.equal(ctx.execution.positions(bindingId).find((p) => p.marketSlug === win.slug)?.settled?.outcome, "correction");
  // Re-reconciling adds nothing (activity ids are unique).
  const before = ctx.execution.settlements().length;
  await ctx.execution.reconcile();
  assert.equal(ctx.execution.settlements().length, before);
});

test("D01/D03 — intents, orders (external labelled, no invented rationale), positions and settlements are listed and exported with amounts and lineage, and no secrets", async () => {
  const intents = (await app.inject({ method: "GET", url: "/api/trading/intents?mode=live" })).json() as TradeIntent[];
  const states = new Set(intents.map((i) => i.state));
  for (const s of ["filled", "partially_filled", "rejected", "rejected_local", "expired"]) assert.ok(states.has(s as never), `state ${s} present: ${[...states].join(",")}`);
  const orders = (await app.inject({ method: "GET", url: "/api/trading/orders" })).json() as { id: string; external: boolean; intentId?: string; state: string }[];
  const external = orders.filter((o) => o.external);
  assert.ok(external.length >= 1);
  assert.ok(external.every((o) => !o.intentId), "external orders carry no intent / rationale");
  const one = (await app.inject({ method: "GET", url: `/api/trading/orders/${intents.find((i) => i.state === "partially_filled")!.venueOrderId}` })).json() as { state: string; executions: unknown[] };
  assert.ok(one.executions.length > 0);
  const positions = (await app.inject({ method: "GET", url: "/api/trading/positions" })).json() as { marketSlug: string; localNet: string; settled?: unknown }[];
  assert.ok(positions.some((p) => p.settled) && positions.some((p) => !p.settled), "settled and open positions are distinct from order states");
  const lease = (await app.inject({ method: "GET", url: "/api/trading/lease" })).json() as { heldByThisProcess: boolean; stream: string };
  assert.deepEqual({ held: lease.heldByThisProcess, stream: lease.stream }, { held: true, stream: "open" });
  // Exports: the lineage export and the full bundle match the database and contain no secret material.
  const exp = (await app.inject({ method: "GET", url: "/api/trading/export" }));
  assert.equal(exp.statusCode, 200);
  const lineage = exp.json() as { intents: TradeIntent[]; orders: unknown[]; executions: unknown[]; settlements: unknown[]; holds: unknown[]; audit: unknown[] };
  assert.equal(lineage.intents.length, ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents")!.n);
  assert.equal(lineage.executions.length, ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM executions")!.n);
  assert.equal(lineage.settlements.length, ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM settlement_events")!.n);
  assert.ok(!exp.body.includes(CANARY));
  const bundle = JSON.stringify(buildExportBundle(ctx));
  assert.ok(!bundle.includes(CANARY));
  const parsed = JSON.parse(bundle) as { tradeIntents: unknown[]; venueOrders: { external: boolean; intentId?: string }[]; executions: unknown[]; settlementEvents: unknown[]; reconciliationHolds: unknown[] };
  assert.equal(parsed.tradeIntents.length, lineage.intents.length);
  assert.ok(parsed.venueOrders.some((o) => o.external && !o.intentId));
  assert.equal(parsed.settlementEvents.length, lineage.settlements.length);
  assert.ok(parsed.reconciliationHolds.length >= 1);
  // Audit trail: every stage of a submission is on record, secret-free.
  const kinds = new Set(ctx.trading.auditEvents(5000).map((e) => e.kind));
  for (const k of ["order.previewed", "order.submitting", "order.acknowledged", "order.submission_unknown", "hold.opened", "hold.resolved", "reconcile.completed", "settlement.recorded", "dispatch.paused", "dispatch.resumed"]) assert.ok(kinds.has(k), k);
  assert.ok(!JSON.stringify(ctx.trading.auditEvents(5000)).includes(CANARY));
});

test("D02 — editing the prediction after a live decision leaves the immutable decision, preview and intent untouched", async () => {
  const v = await liveDecision("d02");
  const preview = await ctx.execution.preview(v.decision.id);
  const i = await ctx.execution.submit(preview.id, { decisionHash: v.decision.rationaleHash });
  ctx.predictions.edit(v.claim.prediction.id, { normalizedStatement: "Detroit wins by a lot" }, "edited after the trade");
  const d = ctx.decisions.get(v.decision.id)!;
  assert.equal(d.rationaleHash, v.decision.rationaleHash);
  assert.deepEqual(d.sizing, v.decision.sizing);
  assert.deepEqual(ctx.execution.getPreview(preview.id)?.display, preview.display);
  assert.equal(ctx.execution.intent(i.id)?.decisionHash, v.decision.rationaleHash);
  assert.equal(ctx.execution.intent(i.id)?.payloadHash, i.payloadHash);
});

test("D04 — a video, prediction or market linked to a live order cannot be deleted through the existing routes; a paper reset does not touch live records", async () => {
  const v = await liveDecision("d04");
  await previewAndSubmit(v.decision);
  const before = { intents: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE mode = 'live'")!.n, orders: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM venue_orders")!.n, executions: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM executions")!.n };
  for (const url of [`/api/videos/${v.claim.video.id}`, `/api/predictions/${v.claim.prediction.id}`, `/api/markets/stored/${v.marketId}`]) {
    const r = await app.inject({ method: "DELETE", url, headers: csrf });
    assert.equal(r.statusCode, 409, url);
    assert.equal(r.json().error, "live_lineage");
  }
  assert.ok(ctx.videos.get(v.claim.video.id) && ctx.predictions.get(v.claim.prediction.id) && ctx.markets.get(v.marketId));
  const reset = await app.inject({ method: "POST", url: "/api/paper/us/reset", headers: csrf });
  assert.equal(reset.statusCode, 200);
  const after = { intents: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE mode = 'live'")!.n, orders: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM venue_orders")!.n, executions: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM executions")!.n };
  assert.deepEqual(after, before);
  // A video with no live lineage still deletes normally.
  const m = market("d04x", "2026-10-01T18:00:00Z");
  const c = claim(A, m.id, "Detroit Lions", "2026-09-30T10:00:00Z");
  assert.equal((await app.inject({ method: "DELETE", url: `/api/videos/${c.video.id}`, headers: csrf })).statusCode, 200);
});

test("R07 (live) — two confirmations racing on different contracts with capacity for one: the caps are re-checked inside the reserving transaction, so exactly one order is sent", async () => {
  // Total open-risk cap = what is open now + room for one order (each needs 9.975); a limits edit disarms → re-arm first,
  // so both decisions and previews are made under the same policy hash.
  const open = exposure().openRiskTotal;
  ctx.trading.setLimits({ totalOpenRisk: D(open).add("12").toString() });
  await arm();
  const a = await liveDecision("r07a");
  const b = await liveDecision("r07b");
  const pa = await ctx.execution.preview(a.decision.id);
  const pb = await ctx.execution.preview(b.decision.id);
  const before = fake.createCalls;
  const results = await Promise.allSettled([
    ctx.execution.submit(pa.id, { decisionHash: a.decision.rationaleHash }),
    ctx.execution.submit(pb.id, { decisionHash: b.decision.rationaleHash }),
  ]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, JSON.stringify(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))));
  assert.equal(lost.length, 1);
  assert.ok(lost[0].status === "rejected" && lost[0].reason instanceof ExecutionError && lost[0].reason.code === "preview_stale", "the loser is told to re-decide; nothing was reserved for it");
  assert.equal(fake.createCalls, before + 1, "one venue create call");
  assert.ok(D(exposure().openRiskTotal).lte(ctx.trading.policy().limits.totalOpenRisk), "never over the cap");
  const loserDecision = (won[0] as PromiseFulfilledResult<TradeIntent>).value.decisionId === a.decision.id ? b.decision.id : a.decision.id;
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM risk_reservations WHERE decision_id = ?", loserDecision)!.n, 0);
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE decision_id = ?", loserDecision)!.n, 0);
  ctx.trading.setLimits({ totalOpenRisk: "1000" });
  await arm();
});

test("O02 — a backup taken while armed with live lineage carries no secret and no live grant; the restored copy keeps every intent/order/execution", async () => {
  const info = createBackup(ctx.db, ctx.paths);
  assert.equal(info.tradingCredentialsIncluded, false);
  const raw = fs.readFileSync(path.join(ctx.paths.backups, info.file));
  assert.ok(!raw.includes(CANARY));
  const { openDatabase } = await import("../db/index.js");
  const restored = fs.mkdtempSync(path.join(os.tmpdir(), "pl-exec-restore-"));
  fs.copyFileSync(path.join(ctx.paths.backups, info.file), path.join(restored, path.basename(ctx.paths.database)));
  const copy = openDatabase({ database: path.join(restored, path.basename(ctx.paths.database)) } as never);
  try {
    assert.deepEqual({ ...copy.db.get<{ mode: string; live_authorized_at: string | null }>("SELECT mode, live_authorized_at FROM trading_policy WHERE id = 'default'") }, { mode: "paper", live_authorized_at: null });
    assert.equal(copy.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE mode = 'live'")!.n, ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE mode = 'live'")!.n);
    assert.equal(copy.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM executions")!.n, ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM executions")!.n);
    assert.equal(copy.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM secrets WHERE name LIKE 'trading.%'")!.n, 0);
    assert.equal(copy.db.get<{ state: string }>("SELECT state FROM trading_accounts WHERE id = ?", bindingId)?.state, "needs_rebind");
  } finally { copy.db.close(); }
  assert.equal(ctx.trading.status().armed, true, "the live database is untouched by taking a backup");
});

test("O03 — two processes on one database: only the lease holder can dispatch; the loser's intent is refused before any POST; lease loss and expiry are honoured by the marker transaction", async () => {
  const { createContext } = await import("../context.js");
  const ctx2 = createContext({ now: () => new Date(Date.parse(clock)), leaseHolder: "proc-2" });
  try {
    assert.equal(ctx.trading.policy().mode, "paper", "a process start finds live mode and disarms it (OPS-02/AUTO-04) — the owner re-arms deliberately");
    await arm();
    assert.equal(ctx2.lease.acquire(60_000), false, "process 2 cannot take a held, unexpired lease");
    assert.equal(ctx2.lease.held(), false);
    assert.equal(ctx2.trading.status().armed, true, "same policy row");
    const v = await liveDecision("o03");
    const preview = await ctx2.execution.preview(v.decision.id);
    const before = fake.createCalls;
    await assert.rejects(() => ctx2.execution.submit(preview.id, { decisionHash: v.decision.rationaleHash }), (e: unknown) => e instanceof ExecutionError && e.code === "dispatch_blocked" && /lease/.test(e.message));
    assert.equal(fake.createCalls, before, "no POST from the process without the lease");
    const lost = ctx2.execution.intents({ bindingId, mode: "live" }).find((i) => i.decisionId === v.decision.id)!;
    assert.equal(lost.state, "rejected_local");
    assert.equal(ctx2.risk.get(lost.reservationId)?.state, "released");
    assert.equal(ctx.risk.opportunityConsumed(bindingId, "polymarket_us", ctx.markets.get(v.marketId)!.venueId), undefined, "opportunity handed back");
    // Process 1 loses the lease (expiry): process 2 takes it; process 1's marker transaction now refuses.
    clock = "2026-10-01T12:02:00Z";
    await ctx.trading.sync();
    assert.equal(ctx.lease.held(), false, "expired");
    assert.equal(ctx2.lease.acquire(60_000), true);
    assert.equal(ctx.lease.acquire(60_000), false, "held by process 2 now");
    const v2 = await liveDecision("o03b");
    const p2 = await ctx.execution.preview(v2.decision.id);
    await assert.rejects(() => ctx.execution.submit(p2.id, { decisionHash: v2.decision.rationaleHash }), (e: unknown) => e instanceof ExecutionError && e.code === "dispatch_blocked");
    assert.equal(fake.createCalls, before);
    // Process 2, holding the lease, dispatches; the row-level uniqueness (one opportunity per contract) holds across processes.
    const v3 = await liveDecision("o03c");
    const p3 = await ctx2.execution.preview(v3.decision.id);
    const sent = await ctx2.execution.submit(p3.id, { decisionHash: v3.decision.rationaleHash });
    assert.equal(sent.state, "filled");
    assert.equal(fake.createCalls, before + 1);
    await assert.rejects(() => ctx.execution.preview(v3.decision.id), (e: unknown) => e instanceof ExecutionError && e.code === "decision_not_eligible");
    ctx2.lease.release();
    assert.equal(ctx.lease.acquire(60_000), true);
    ctx.db.run("DELETE FROM trading_account_syncs WHERE at > ?", T);
    clock = T;
    await ctx.trading.sync();
  } finally { ctx2.execution.stopStream(); ctx2.db.close(); }
});

test("O01 — the canary secret never appears in status, intents, orders, holds, previews, exports or errors; a disarm is immediate and audited", async () => {
  const blobs = [
    JSON.stringify(ctx.trading.status()), JSON.stringify(ctx.execution.intents({ limit: 10_000 })), JSON.stringify(ctx.execution.orders({ limit: 10_000 })), JSON.stringify(ctx.execution.holds()),
    JSON.stringify(ctx.db.all("SELECT * FROM order_previews")), JSON.stringify(ctx.db.all("SELECT * FROM trade_intents")), JSON.stringify(ctx.db.all("SELECT * FROM venue_orders")), JSON.stringify(ctx.db.all("SELECT * FROM reconciliation_holds")),
    JSON.stringify(ctx.db.all("SELECT * FROM trading_audit_events")), JSON.stringify(ctx.db.all("SELECT * FROM executions")),
  ];
  for (const b of blobs) assert.ok(!b.includes(CANARY));
  const disarm = await app.inject({ method: "POST", url: "/api/trading/disarm", headers: csrf, payload: { reason: "owner check" } });
  assert.equal(disarm.statusCode, 200);
  assert.equal(disarm.json().policy.mode, "paper");
  assert.equal(disarm.json().status.armed, false);
  assert.equal(ctx.trading.auditEvents().find((e) => e.kind === "trading.disarmed")?.details.reason, "owner check");
  const v = await liveDecision("o01").catch((e: Error) => e);
  assert.ok(v instanceof Error, "no manual-live decision can even be produced while disarmed");
});
