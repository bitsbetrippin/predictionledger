/**
 * Prediction Ledger — 2.0 release-review regressions (RV-01 … RV-14) against the fake venue.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Each test reproduces a finding of the 2.0 code review (docs/VERIFICATION.md, "Release 2.0.0-rc.1 — review findings")
 * on the production code path and asserts the fixed behaviour. No network, no real key, no real money.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { AUTO_LIVE_ACKNOWLEDGEMENT, type TradeDecision } from "@prediction-ledger/shared";
import type { MarketProvider, MarketSummary, OrderBookSnapshot, PricePoint } from "../providers/markets/types.js";
import { setMarketProviderForTests } from "../providers/markets/registry.js";
import { FakeTradingAdapter, fakeBalance } from "../providers/trading/fake.js";
import { setTradingAdapterForTests } from "../providers/trading/registry.js";
import Fastify from "fastify";
import { CSRF_HEADER, CSRF_VALUE } from "@prediction-ledger/shared";
import { registerCsrfGuard } from "../security/csrf.js";
import { registerDecisionRoutes } from "../routes/decisions.js";
import type { AppContext } from "../context.js";
import { ExecutionError, type FaultInjector, type FaultPoint } from "./execution.js";
import { LIVE_ACKNOWLEDGEMENT } from "./tradingAccounts.js";
import { D } from "../analysis/decimal.js";
import { signedFilledQuantity } from "../analysis/orderState.js";

const RULES = "If Detroit wins, the market will resolve to Lions. If Buffalo wins, the market will resolve to Bills. If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, this market will resolve 50-50.";
const LIONS = { name: "Detroit Lions", abbreviation: "DET", league: "nfl", alias: "Lions" };
const BILLS = { name: "Buffalo Bills", abbreviation: "BUF", league: "nfl", alias: "Bills" };
const T = "2026-10-01T12:00:00Z";
const KEY = "11111111-2222-3333-4444-555555555555";
const SECRET = crypto.randomBytes(32).toString("base64");

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
  books = new Map<string, { bid: number; ask: number }>();
  /** When set, books are stamped with this instant instead of the test clock (RV-03). */
  bookAt?: string;
  async search(): Promise<MarketSummary[]> { return []; }
  async get(idOrSlug: string): Promise<MarketSummary | undefined> { return this.byId.get(idOrSlug); }
  async list(): Promise<MarketSummary[]> { return []; }
  async book(tokenId: string): Promise<OrderBookSnapshot> {
    const slug = tokenId.replace(/:(YES|NO)$/, "");
    const b = this.books.get(slug) ?? { bid: 0.49, ask: 0.5 };
    return { provider: "polymarket_us", tokenId, bids: [{ price: b.bid, size: 500 }], asks: [{ price: b.ask, size: 500 }], retrievedAt: this.bookAt ?? clock };
  }
  async priceHistory(): Promise<PricePoint[]> { return []; }
  async eventMarkets(): Promise<MarketSummary[]> { return []; }
}

/** Fault points can throw (crash drills) or run a hook (a second process acting between two commits, RV-02). */
class Faults implements FaultInjector {
  arm?: FaultPoint;
  hooks = new Map<FaultPoint, () => void>();
  at(point: FaultPoint): void {
    const h = this.hooks.get(point);
    if (h) { this.hooks.delete(point); h(); }
    if (this.arm === point) { this.arm = undefined; throw new Error(`injected crash at ${point}`); }
  }
}

let ctx: AppContext;
let dataDir: string;
const fakeUs = new FakeUs();
const fake = new FakeTradingAdapter();
const faults = new Faults();
let clock = T;
/** RV-03: successive `now()` calls take these offsets (ms after T) in order; when the queue is empty the clock is `clock`. */
const nowQueue: number[] = [];
const nowFn = () => (nowQueue.length ? new Date(Date.parse(T) + nowQueue.shift()!) : new Date(Date.parse(clock)));
let seq = 0;
let bindingId = "";
const A = { channelId: "UC-A", name: "Creator A" };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-review20-"));
  process.env.PL_DATA_DIR = dataDir;
  setMarketProviderForTests("polymarket_us", fakeUs);
  setTradingAdapterForTests(fake);
  fake.now = () => new Date(Date.parse(clock));
  const { createContext } = await import("../context.js");
  ctx = createContext({ now: nowFn, faults, leaseHolder: "proc-1" });
  const s = ctx.settings.getPersisted();
  s.privacy.allowInternet = true;
  s.markets.venues = ["polymarket", "polymarket_us"];
  ctx.settings.savePersisted(s);
  const games: [string, string, string, "Lions" | "Bills"][] = [["g01", "2026-09-01", "2026-08-31T23:00:00Z", "Lions"], ["g02", "2026-09-02", "2026-09-01T23:00:00Z", "Lions"], ["g03", "2026-09-03", "2026-09-02T23:00:00Z", "Lions"], ["g04", "2026-09-04", "2026-09-03T23:00:00Z", "Bills"]];
  for (const [id, day, priceAt, winner] of games) { const m = market(id, `${day}T17:00:00Z`, { yesPrice: 0.25, priceAt }); claim(A, m.id, "Detroit Lions", day); resolve(id, winner, `${day}T21:00:00Z`); }
  fake.script(KEY, { secretKey: SECRET, balances: [fakeBalance("1000.00", "1000.00")] });
  bindingId = (await ctx.trading.connect({ keyId: KEY, secretKey: SECRET })).binding.id;
  ctx.trading.setLimits({ maxOpenMarkets: 50, totalOpenRisk: "1000", dailyCommitmentCap: "1000", perEvent: "100", dailyLossStop: "1000" }, { budgetTimezone: "UTC" });
  ctx.trading.setAutomation({ minReevaluateMs: 0, intervalMs: 5_000 });
  await ctx.trading.sync();
  assert.ok(ctx.lease.acquire(60_000));
  await armManual();
  await ctx.execution.startStream();
});
after(async () => { ctx?.autoTrader.stop(); ctx?.execution.stopStream(); ctx?.db.close(); delete process.env.PL_DATA_DIR; setMarketProviderForTests("polymarket_us", undefined); setTradingAdapterForTests(undefined); });

async function armManual(): Promise<void> {
  assert.ok(ctx.lease.acquire(60_000));
  if (ctx.trading.policy().pauseReason) ctx.trading.resume();
  await ctx.trading.sync();
  ctx.trading.setMode("manual_live", { acknowledge: LIVE_ACKNOWLEDGEMENT });
  assert.equal(ctx.trading.status().armed, true);
}

/** TEST SHORTCUT (labelled): a production qualification row + the paper rehearsal by SQL; never strategy evidence. */
function qualify(category: string): void {
  if (!ctx.trading.qualificationFor(ctx.forecasts.strategyVersion, category)) {
    ctx.db.run("INSERT INTO strategy_qualifications (id, strategy_version, category, source, events, brier, baseline_brier, qualified, report_json, created_at) VALUES (?, ?, ?, 'production', 120, '0.20', '0.22', 1, ?, ?)", crypto.randomUUID(), ctx.forecasts.strategyVersion, category, JSON.stringify({ note: "TEST SHORTCUT — inserted by review20.test.ts; not strategy evidence", gate: { reasons: [] } }), clock);
  }
  const settled = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM paper_us_positions WHERE status = 'settled'")!.n;
  for (let i = settled; i < 20; i++) {
    ctx.db.run("INSERT INTO paper_us_positions (id, intent_id, decision_id, market_id, venue_market_id, side, quantity, avg_cost, cost_total, fees, status, opened_at, settled_at, outcome, pnl, method) VALUES (?, ?, ?, ?, ?, 'yes', '1', '0.5', '0.5', '0', 'settled', ?, ?, 'win', '0.5', 'us-ioc-v1')", crypto.randomUUID(), `test-intent-${i}`, `test-decision-${i}`, "rehearsal", `rehearsal-${i}`, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z");
  }
}
async function armAuto(category = "sports"): Promise<void> {
  qualify(category);
  assert.ok(ctx.lease.acquire(60_000));
  await ctx.trading.sync();
  ctx.trading.arm({ acknowledge: AUTO_LIVE_ACKNOWLEDGEMENT, policyHash: ctx.trading.policy().policyHash, category, strategyVersion: ctx.forecasts.strategyVersion });
  assert.equal(ctx.trading.policy().mode, "auto_live");
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
  const id = `r${String(seq).padStart(4, "0")}${creator.channelId.slice(0, 3)}`;
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
async function liveDecision(id: string, opts: { now?: string; expect?: TradeDecision["outcome"] } = {}) {
  const m = market(id, "2026-10-01T18:00:00Z");
  const c = claim(A, m.id, "Detroit Lions", "2026-09-30T10:00:00Z");
  const decision = await ctx.decisions.evaluate({ predictionId: c.prediction.id, linkId: c.link.id, now: opts.now ?? clock, reuseForecast: false });
  if (opts.expect) assert.equal(decision.outcome, opts.expect, `${id}: ${JSON.stringify(decision.gates.filter((g) => !g.satisfied))}`);
  return { decision, marketId: m.id, slug: m.constraints!.slug!, claim: c };
}
const openHolds = () => ctx.execution.holds(bindingId, true);
const createCalls = () => fake.createCalls;

// ------------------------------------------------------------------------------------------------------------------

test("RV-01 — an auto-live decision must fall inside the armed (strategy version, category): a qualified forecast for another category or version is skipped, previews refuse it, and the scheduler places nothing", async () => {
  await armAuto("sports");
  const p = ctx.trading.policy();
  assert.equal(p.authorizedCategory, "sports");
  // Inside the scope: eligible (the order is placed through the scheduler's path in U02; here we only decide).
  const inScope = await liveDecision("rv01a", { expect: "eligible" });
  assert.ok(inScope.decision.gates.find((g) => g.id === "authorized_scope")?.satisfied);
  // The armed scope changes underneath (what an owner arming "politics" would look like): the same kind of forecast is now out of scope.
  ctx.db.run("UPDATE trading_policy SET authorized_category = 'politics'");
  const outOfScope = await liveDecision("rv01b", { expect: "skipped" });
  assert.ok(outOfScope.decision.reasonCodes.includes("AUTHORIZATION_SCOPE"), outOfScope.decision.reasonCodes.join(","));
  // A decision made inside the scope cannot be previewed once the scope no longer covers it (the fresh re-decision fails the gate).
  const before = createCalls();
  await assert.rejects(() => ctx.execution.preview(inScope.decision.id), (e: unknown) => e instanceof ExecutionError && e.code === "decision_not_eligible" && (e.detail as string[]).includes("AUTHORIZATION_SCOPE"));
  // Strategy version mismatch is the same gate.
  ctx.db.run("UPDATE trading_policy SET authorized_category = 'sports', authorized_strategy_version = 'someone-elses-v9'");
  const wrongVersion = await liveDecision("rv01c", { expect: "skipped" });
  assert.ok(wrongVersion.decision.reasonCodes.includes("AUTHORIZATION_SCOPE"));
  const run = await ctx.autoTrader.tick();
  assert.equal(run.ordered, 0, JSON.stringify(run));
  assert.equal(createCalls(), before, "nothing was sent outside the armed scope");
  ctx.trading.disarm("test cleanup");
  await armManual();
});

test("RV-03 — the decision instant is taken after its inputs: a book fetched 2.5 s after the call began is fresh (not 'from the future'); evaluate, preview and submit all pass on a real-time clock", async () => {
  // Old behaviour: now = first call (T+3.5 s), book at T+6 s → age −2.5 s → BOOK_STALE for every real decision.
  const m = market("rv03", "2026-10-01T18:00:00Z");
  const c = claim(A, m.id, "Detroit Lions", "2026-09-30T10:00:00Z");
  fakeUs.bookAt = new Date(Date.parse(T) + 6_000).toISOString();
  nowQueue.push(3_500, 7_000);
  const d = await ctx.decisions.evaluate({ predictionId: c.prediction.id, linkId: c.link.id, reuseForecast: false });
  nowQueue.length = 0;
  assert.equal(d.outcome, "needs_review", JSON.stringify(d.gates.filter((g) => !g.satisfied)));
  assert.equal(d.clockAt, new Date(Date.parse(T) + 7_000).toISOString(), "the decision's instant is the one taken after the inputs were gathered");
  const ages = d.inputs.ages as { bookMs?: number };
  assert.ok(ages.bookMs! >= 0 && ages.bookMs! <= 10_000, `book age ${ages.bookMs}`);
  // Preview: the sync check and the instant are both taken after the fetch; the scheduler passes no pinned clock either.
  nowQueue.push(7_500, 8_000);
  const preview = await ctx.execution.preview(d.id);
  nowQueue.length = 0;
  assert.equal(preview.display.origin, "owner");
  // Submit: the provisional instant only checks expiry; the reserving instant follows the fresh inputs.
  const before = createCalls();
  nowQueue.push(8_500, 9_000, 9_500);
  const intent = await ctx.execution.submit(preview.id, { decisionHash: d.rationaleHash });
  nowQueue.length = 0;
  fakeUs.bookAt = undefined;
  assert.equal(createCalls(), before + 1);
  assert.equal(intent.state, "filled");
});

test("RV-02 — a second process's crash recovery cannot corrupt a submission the first process still has in flight: the venue's answer wins, the hold resolves itself, and a marker that no longer moves the row sends nothing", async () => {
  // (a) Process 1 has the POST in flight (300 ms); process 2 recovers meanwhile and marks the intent unknown.
  const { createContext } = await import("../context.js");
  const { decision, slug } = await liveDecision("rv02a", { expect: "needs_review" });
  fake.behave(slug, { mode: "fill", responseDelayMs: 300 });
  const preview = await ctx.execution.preview(decision.id);
  const before = createCalls();
  const inFlight = ctx.execution.submit(preview.id, { decisionHash: decision.rationaleHash });
  await new Promise((r) => setTimeout(r, 50));
  const ctx2 = createContext({ now: () => new Date(Date.parse(clock)), leaseHolder: "proc-2" });
  try {
    const rec = ctx2.execution.recoverAfterCrash();
    assert.equal(rec.unknown.length, 1, "process 2 (without the lease guard of index.ts) marks the in-flight intent unknown");
    const intent = await inFlight;
    assert.equal(createCalls(), before + 1, "exactly one POST");
    assert.equal(intent.state, "filled", "the venue's answer to the original POST acknowledges the intent; the fill follows");
    assert.equal(intent.unknownReason, undefined);
    assert.equal(openHolds().filter((h) => h.kind === "submission_unknown" && h.subject === intent.id).length, 0, "the hold opened by process 2 is resolved by the acknowledgement, not stuck");
    assert.ok(ctx.execution.holds(bindingId).find((h) => h.subject === intent.id && h.resolvedAt && /recovered by another process/.test(h.resolution ?? "")));
    // (process 2's startupCheck disarmed the policy — OPS-02 — so "mode is paper" is expected; no hold-related blocker remains.)
    assert.ok(!ctx.trading.dispatchBlockers().some((b) => /hold|unknown/.test(b)), JSON.stringify(ctx.trading.dispatchBlockers()));
  } finally { ctx2.db.close(); }
  await armManual();
  // (b) Process 3 expires a `reserved` intent between process 1's T1 and T2: T2 finds no row to mark and sends nothing.
  // (Process 3 is started first — its startup check disarms, OPS-02 — and process 1 re-arms before confirming.)
  const ctx3 = createContext({ now: () => new Date(Date.parse(clock)), leaseHolder: "proc-3" });
  await armManual();
  const p2 = await liveDecision("rv02b", { expect: "needs_review" });
  const pv2 = await ctx.execution.preview(p2.decision.id);
  try {
    faults.hooks.set("after_reserve", () => { const r = ctx3.execution.recoverAfterCrash(); assert.equal(r.expired.length, 1, "process 3 expires the reserved-but-unmarked intent"); });
    const before2 = createCalls();
    await assert.rejects(() => ctx.execution.submit(pv2.id, { decisionHash: p2.decision.rationaleHash }), (e: unknown) => e instanceof ExecutionError && e.code === "dispatch_blocked" && /no longer reserved/.test(e.message));
    assert.equal(createCalls(), before2, "no POST after the marker failed to move the row");
    const intents = ctx.execution.intents({ bindingId, mode: "live" }).filter((i) => i.decisionId === p2.decision.id);
    assert.equal(intents.length, 1);
    assert.equal(intents[0].state, "expired");
    assert.equal(ctx.risk.get(intents[0].reservationId)?.state, "released", "released exactly once");
  } finally { ctx3.db.close(); }
  // A second createContext on the same directory disarms (OPS-02); re-arm for the following tests.
  await armManual();
});

test("RV-09 — the venue's manual/automatic indicator follows who sends the order: an owner-confirmed order in auto-live mode is MANUAL, a scheduler order is AUTOMATIC", async () => {
  await armAuto("sports");
  const { decision } = await liveDecision("rv09a", { expect: "eligible" });
  const owner = await ctx.execution.preview(decision.id);
  assert.equal(owner.request.manualOrderIndicator, "MANUAL_ORDER_INDICATOR_MANUAL");
  const before = createCalls();
  await ctx.execution.submit(owner.id, { decisionHash: decision.rationaleHash });
  const sent = fake.calls.filter((c) => c.method === "createOrder");
  assert.equal(sent.length, before + 1);
  assert.equal((sent.at(-1)!.args as { manual: boolean }).manual, true, "owner-confirmed → manual indicator");
  const d2 = await liveDecision("rv09b", { expect: "eligible" });
  const sched = await ctx.execution.preview(d2.decision.id, { origin: "scheduler" });
  assert.equal(sched.request.manualOrderIndicator, "MANUAL_ORDER_INDICATOR_AUTOMATIC");
  await ctx.execution.submit(sched.id, { decisionHash: d2.decision.rationaleHash });
  assert.equal((fake.calls.filter((c) => c.method === "createOrder").at(-1)!.args as { manual: boolean }).manual, false, "scheduler → automatic indicator");
  ctx.trading.disarm("test cleanup");
  await armManual();
});

test("RV-12 — a 429 on the create call is ambiguous (the order may exist): held as submission_unknown, opportunity kept, never resent; the breaker counts it", async () => {
  const { decision, slug } = await liveDecision("rv12", { expect: "needs_review" });
  fake.behave(slug, { mode: "rate_limit" });
  const preview = await ctx.execution.preview(decision.id);
  const before = createCalls();
  const intent = await ctx.execution.submit(preview.id, { decisionHash: decision.rationaleHash });
  assert.equal(intent.state, "submission_unknown", intent.lastError);
  assert.match(intent.unknownReason ?? "", /429/);
  assert.ok(ctx.risk.opportunityConsumed(bindingId, "polymarket_us", intent.venueMarketId), "the opportunity stays consumed until the owner resolves the hold");
  assert.equal(ctx.risk.get(intent.reservationId)?.state, "reserved");
  assert.ok(openHolds().some((h) => h.kind === "submission_unknown" && h.subject === intent.id));
  // Resolution as not submitted releases it; nothing was resent meanwhile.
  await ctx.execution.reconcile();
  ctx.execution.resolveUnknown(intent.id, { outcome: "not_submitted" }, "venue shows no order after the 429");
  assert.equal(ctx.execution.intent(intent.id)?.state, "rejected_local");
  assert.equal(createCalls(), before + 1, "exactly one attempt (the fake counts the throttled call); nothing was resent after the hold or its resolution");
  fake.behave(slug, { mode: "fill" });
});

test("RV-10 / RV-14 — resolving an unknown submission can only link an order on the same contract and side, with a known side and matching quantity", async () => {
  const { decision, slug } = await liveDecision("rv10", { expect: "needs_review" });
  fake.behave(slug, { mode: "drop_response" });
  const preview = await ctx.execution.preview(decision.id);
  const intent = await ctx.execution.submit(preview.id, { decisionHash: decision.rationaleHash });
  assert.equal(intent.state, "submission_unknown");
  fake.behave(slug, { mode: "fill" });
  // An order on ANOTHER market, an order on the other side, and an order with a different quantity are all refused.
  const other = fake.externalOrder("aec-nfl-det-buf-rv09a", "yes", intent.quantity, intent.wirePrice, { fill: true });
  const otherSide = fake.externalOrder(slug, "no", intent.quantity, intent.wirePrice, { fill: true });
  const otherQty = fake.externalOrder(slug, "yes", "3", intent.wirePrice, { fill: true });
  await ctx.execution.reconcile();
  for (const id of [other.id, otherSide.id, otherQty.id]) {
    assert.throws(() => ctx.execution.resolveUnknown(intent.id, { venueOrderId: id }, "wrong"), (e: unknown) => e instanceof ExecutionError && e.code === "order_mismatch", id);
  }
  // An order whose side the app has not read yet is refused until it is read back.
  ctx.db.run("INSERT INTO venue_orders (id, binding_id, intent_id, external, market_slug, venue_market_id, side, state, quantity, filled_quantity, updated_at, first_seen_at) VALUES ('mystery-1', ?, NULL, 1, ?, ?, NULL, 'unknown', ?, '0', ?, ?)", bindingId, slug, intent.venueMarketId, intent.quantity, clock, clock);
  assert.throws(() => ctx.execution.resolveUnknown(intent.id, { venueOrderId: "mystery-1" }, "?"), (e: unknown) => e instanceof ExecutionError && e.code === "order_side_unknown");
  assert.equal(ctx.execution.intent(intent.id)?.state, "submission_unknown", "still unknown after every refused link");
  // The genuine candidate (the venue created it on the dropped response) links.
  const candidates = ctx.execution.holds(bindingId, true).find((h) => h.subject === intent.id)!.detail.candidates as string[];
  assert.equal(candidates.length, 1);
  const linked = ctx.execution.resolveUnknown(intent.id, { venueOrderId: candidates[0] }, "matches the dropped response");
  assert.equal(linked.state, "filled");
  ctx.db.run("DELETE FROM venue_orders WHERE id = 'mystery-1'");
});

test("RV-13 — the emergency stop waits for a POST already in flight and cancels its order in the same sweep (no second sweep needed)", async () => {
  const { decision, slug } = await liveDecision("rv13", { expect: "needs_review" });
  fake.behave(slug, { mode: "rest", responseDelayMs: 250 }); // the order rests open at the venue, response held 250 ms
  const preview = await ctx.execution.preview(decision.id);
  const inFlight = ctx.execution.submit(preview.id, { decisionHash: decision.rationaleHash });
  await new Promise((r) => setTimeout(r, 30));
  const stop = await ctx.execution.emergencyStop("RV-13 drill");
  const intent = await inFlight;
  assert.equal(intent.venueOrderId && stop.cancellations.map((c) => c.venueOrderId).includes(intent.venueOrderId), true, `the in-flight order ${intent.venueOrderId} was targeted by the stop's own sweep: ${JSON.stringify(stop.cancellations)}`);
  assert.equal(ctx.execution.order(intent.venueOrderId!)?.state, "canceled");
  fake.behave(slug, { mode: "fill" });
  ctx.trading.resume();
  await armManual();
});

test("RV-05 — activities delivered newest-first are applied oldest-first: the original resolution is 'resolved' and the later one 'correction'", async () => {
  const { decision, slug } = await liveDecision("rv05", { expect: "needs_review" });
  const preview = await ctx.execution.preview(decision.id);
  const intent = await ctx.execution.submit(preview.id, { decisionHash: decision.rationaleHash });
  assert.equal(intent.state, "filled");
  fake.activitiesNewestFirst = true;
  clock = "2026-10-01T22:00:00Z"; fake.settle(slug, "yes");
  clock = "2026-10-01T23:00:00Z"; fake.settle(slug, "no", { correction: true });
  clock = T;
  ctx.db.run("DELETE FROM trading_account_syncs WHERE at > ?", T);
  await ctx.execution.reconcile();
  fake.activitiesNewestFirst = false;
  const events = ctx.execution.settlements().filter((e) => e.venueMarketId === intent.venueMarketId && !e.intentId).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  assert.deepEqual(events.map((e) => [e.kind, e.outcome]), [["resolved", "yes"], ["correction", "no"]]);
});

test("RV-04 — a settlement whose venue-reported realized amount contradicts the app's reading of the resolution side is contested: a discrepancy hold pauses new orders; a consistent one is not", async () => {
  await armManual();
  const a = await liveDecision("rv04a", { expect: "needs_review" });
  const ia = await ctx.execution.submit((await ctx.execution.preview(a.decision.id)).id, { decisionHash: a.decision.rationaleHash });
  assert.equal(ia.state, "filled");
  fake.settle(a.slug, "yes", { realizedPnl: "9.50" }); // we hold YES, YES won, venue says +9.50: consistent
  await ctx.execution.reconcile();
  assert.equal(openHolds().filter((h) => h.kind === "discrepancy" && String(h.subject).startsWith("settlement:") && (h.detail as { marketSlug: string }).marketSlug === a.slug).length, 0, "consistent settlement → no hold");
  const b = await liveDecision("rv04b", { expect: "needs_review" });
  const ib = await ctx.execution.submit((await ctx.execution.preview(b.decision.id)).id, { decisionHash: b.decision.rationaleHash });
  assert.equal(ib.state, "filled");
  fake.settle(b.slug, "yes", { realizedPnl: "-9.50" }); // we hold YES; the app reads "YES won" but the venue reports a loss → contested
  await ctx.execution.reconcile();
  const contested = openHolds().find((h) => h.kind === "discrepancy" && String(h.subject).startsWith("settlement:") && (h.detail as { marketSlug: string }).marketSlug === b.slug);
  assert.ok(contested, JSON.stringify(openHolds()));
  assert.equal((contested!.detail as { venueRealized: string }).venueRealized, "-9.5");
  assert.ok(ctx.trading.dispatchBlockers().length > 0, "paused until the owner checks the venue's statement");
  assert.ok(ctx.tradingAlerts.list({ openOnly: true }).some((x) => x.kind === "discrepancy" && x.incidentKey.startsWith("settlement:")));
  ctx.execution.resolveHold(contested!.id, "checked on the venue: test cleanup");
});

test("RV-08 — an order placed on the website that SELLS reduces the position: the app's expected net follows action × side, so no false discrepancy is raised", () => {
  assert.equal(signedFilledQuantity("ORDER_INTENT_BUY_LONG", "yes", "6").toString(), "6");
  assert.equal(signedFilledQuantity("ORDER_INTENT_SELL_LONG", "yes", "6").toString(), "-6");
  assert.equal(signedFilledQuantity("ORDER_INTENT_BUY_SHORT", "no", "6").toString(), "-6");
  assert.equal(signedFilledQuantity("ORDER_INTENT_SELL_SHORT", "no", "6").toString(), "6");
  assert.equal(signedFilledQuantity(undefined, "no", "6").toString(), "-6", "no intent text: a buy on that side (the app's own orders)");
  assert.equal(signedFilledQuantity("ORDER_INTENT_SELL_LONG", undefined, "6").toString(), "-6", "side derived from the intent text");
});

test("RV-08 (venue) — we hold 19 YES, the owner sells 6 on the website: venue 13 = ours 19 + external −6, no discrepancy hold", async () => {
  await armManual();
  const { decision, slug } = await liveDecision("rv08", { expect: "needs_review" });
  const intent = await ctx.execution.submit((await ctx.execution.preview(decision.id)).id, { decisionHash: decision.rationaleHash });
  assert.equal(intent.filledQuantity, "19");
  fake.externalOrder(slug, "yes", "6", "0.55", { fill: true, action: "sell" });
  await ctx.execution.reconcile();
  const pos = ctx.execution.positions(bindingId).find((p) => p.marketSlug === slug)!;
  assert.equal(pos.venueNet, "13");
  assert.equal(pos.discrepancy, undefined, pos.discrepancy);
  assert.equal(openHolds().filter((h) => h.kind === "discrepancy" && h.subject === slug).length, 0);
});

test("RV-06 — the daily loss stop uses the budget timezone's day: a loss at 01:00 UTC on Oct 2 belongs to Oct 1 in New York", () => {
  const key = `rv06-${crypto.randomUUID().slice(0, 8)}`;
  ctx.db.run("INSERT INTO settlement_events (id, market_id, venue_market_id, kind, outcome, source, observed_at, details_json, binding_id, intent_id, amount, activity_id) VALUES (?, 'm-rv06', 'vm-rv06', 'resolved', 'no', 'account_activity', '2026-10-02T01:00:00Z', '{}', ?, 'i-rv06', '-7.25', NULL)", crypto.randomUUID(), key);
  assert.equal(ctx.risk.exposure(key, "2026-10-01", { timezone: "America/New_York" }).dailyRealizedLoss, "7.25");
  assert.equal(ctx.risk.exposure(key, "2026-10-02", { timezone: "America/New_York" }).dailyRealizedLoss, "0");
  assert.equal(ctx.risk.exposure(key, "2026-10-02", { timezone: "UTC" }).dailyRealizedLoss, "7.25");
  assert.equal(ctx.risk.exposure(key, "2026-10-01", { timezone: "UTC" }).dailyRealizedLoss, "0");
});

test("RV-11 — a later production evaluation that fails the gate revokes the qualification: arming is refused and forecasts fall back to experimental", async () => {
  qualify("sports");
  assert.equal(ctx.trading.qualificationFor(ctx.forecasts.strategyVersion, "sports"), true);
  assert.ok(ctx.forecasts.qualifiedCategories().includes("sports"));
  ctx.db.run("INSERT INTO strategy_qualifications (id, strategy_version, category, source, events, brier, baseline_brier, qualified, report_json, created_at) VALUES (?, ?, 'sports', 'production', 130, '0.26', '0.22', 0, ?, ?)", crypto.randomUUID(), ctx.forecasts.strategyVersion, JSON.stringify({ note: "TEST — a later evaluation worse than the baseline", gate: { reasons: ["brier_worse_than_baseline"] } }), "2026-10-01T12:30:00Z");
  assert.equal(ctx.trading.qualificationFor(ctx.forecasts.strategyVersion, "sports"), false, "the newest production record decides");
  assert.ok(!ctx.forecasts.qualifiedCategories().includes("sports"));
  assert.equal(ctx.forecasts.productionQualification(ctx.forecasts.strategyVersion, "sports"), undefined);
  await ctx.trading.sync();
  assert.throws(() => ctx.trading.arm({ acknowledge: AUTO_LIVE_ACKNOWLEDGEMENT, policyHash: ctx.trading.policy().policyHash, category: "sports", strategyVersion: ctx.forecasts.strategyVersion }), (e: unknown) => /strategy_qualified/.test(JSON.stringify((e as { gates?: unknown }).gates ?? (e as Error).message)));
  const d = await liveDecision("rv11");
  const f = ctx.forecasts.get(d.decision.forecastId!)!;
  assert.equal(f.status, "experimental");
  assert.equal(D(f.pYes).gt("0.5"), true);
});

test("FOR-06/07 (2.0) — recording a production evaluation is a deliberate owner action: exact acknowledgement required, the record is written with the gate's verdict (here: not qualified), audited, and never arms anything", async () => {
  const app = Fastify();
  registerCsrfGuard(app, () => ["http://127.0.0.1:7317"]);
  registerDecisionRoutes(app, ctx);
  const csrf = { [CSRF_HEADER]: CSRF_VALUE, origin: "http://127.0.0.1:7317" };
  const bad = await app.inject({ method: "POST", url: "/api/forecasts/evaluation/record", headers: csrf, payload: { category: "sports", acknowledge: "yes" } });
  assert.equal(bad.statusCode, 400);
  const before = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM strategy_qualifications WHERE source = 'production'")!.n;
  const r = await app.inject({ method: "POST", url: "/api/forecasts/evaluation/record", headers: csrf, payload: { category: "sports", acknowledge: "I am recording a production evaluation over real settled events" } });
  assert.equal(r.statusCode, 201, r.body);
  const body = r.json() as { gate: { qualified: boolean; reasons: string[] }; report: { status: string; statement: string } };
  assert.equal(body.gate.qualified, false, "this small synthetic cohort cannot qualify");
  assert.ok(["pending", "failed"].includes(body.report.status));
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM strategy_qualifications WHERE source = 'production'")!.n, before + 1, "a failed evaluation is recorded too (and revokes an earlier pass, RV-11)");
  assert.equal(ctx.trading.qualificationFor(ctx.forecasts.strategyVersion, "sports"), false);
  assert.ok(ctx.db.get("SELECT 1 FROM trading_audit_events WHERE kind = 'qualification.recorded'"));
  assert.notEqual(ctx.trading.policy().mode, "auto_live");
});

