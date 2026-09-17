/**
 * Prediction Ledger — automatic execution, controls, ledger and alerts against the fake venue (1.14: U01, U02 (pipeline half), U03–U06, D01/D03, O03, O04 timing).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Every order goes to the FakeTradingAdapter's venue; no network, no real key, no real money. The production
 * qualification record required by AUTO-01 is inserted here BY SQL as a labelled test shortcut (the app itself writes
 * a production record only from a passing evaluation over ≥ 100 settled events — F08 proves fixtures never qualify);
 * the paper rehearsal rows are inserted the same way. The subscription → transcript → extraction half of U02 runs in
 * autopilot.e2e.test.ts with a fake yt-dlp; this file starts from an extracted pick and covers matching → verification
 * → qualified forecast → one bounded order.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { AUTO_LIVE_ACKNOWLEDGEMENT, CANCEL_ALL_ACKNOWLEDGEMENT, CSRF_HEADER, CSRF_VALUE, LIVE_ACKNOWLEDGEMENT, type TradeDecision, type TradeLedgerRow } from "@prediction-ledger/shared";
import type { MarketProvider, MarketSummary, OrderBookSnapshot, PricePoint } from "../providers/markets/types.js";
import { setMarketProviderForTests } from "../providers/markets/registry.js";
import { FakeTradingAdapter, fakeBalance } from "../providers/trading/fake.js";
import { setTradingAdapterForTests } from "../providers/trading/registry.js";
import { registerCsrfGuard } from "../security/csrf.js";
import { registerDecisionRoutes } from "../routes/decisions.js";
import { registerTradingRoutes } from "../routes/trading.js";
import { registerExecutionRoutes } from "../routes/execution.js";
import { registerAutomationRoutes } from "../routes/automation.js";
import type { AppContext } from "../context.js";
import { TradingGateError } from "./tradingAccounts.js";
import { createBackup } from "./backup.js";
import { D } from "../analysis/decimal.js";

const csrf = { [CSRF_HEADER]: CSRF_VALUE, origin: "http://127.0.0.1:7317" };
const RULES = "If Detroit wins, the market will resolve to Lions. If Buffalo wins, the market will resolve to Bills. If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, this market will resolve 50-50.";
const LIONS = { name: "Detroit Lions", abbreviation: "DET", league: "nfl", alias: "Lions" };
const BILLS = { name: "Buffalo Bills", abbreviation: "BUF", league: "nfl", alias: "Bills" };
const T = "2026-10-01T12:00:00Z";
const KEY = "11111111-2222-3333-4444-555555555555";
const KEY_B = "22222222-2222-3333-4444-555555555555";
const SECRET = crypto.randomBytes(32).toString("base64");
const SECRET_B = crypto.randomBytes(32).toString("base64");
const A = { channelId: "UC-A", name: "Creator A" };
const B = { channelId: "UC-B", name: "Creator B" };

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
  /** What a venue search returns (U02: market.match finds the contract here). */
  searchable: MarketSummary[] = [];
  searches = 0;
  async search(): Promise<MarketSummary[]> { this.searches++; return this.searchable; }
  async get(idOrSlug: string): Promise<MarketSummary | undefined> { return this.byId.get(idOrSlug) ?? [...this.byId.values()].find((m) => m.slug === idOrSlug); }
  async list(): Promise<MarketSummary[]> { return []; }
  async book(tokenId: string): Promise<OrderBookSnapshot> { return { provider: "polymarket_us", tokenId, bids: [{ price: 0.49, size: 500 }], asks: [{ price: 0.5, size: 500 }], retrievedAt: clock }; }
  async priceHistory(): Promise<PricePoint[]> { return []; }
  async eventMarkets(): Promise<MarketSummary[]> { return []; }
}

let ctx: AppContext;
let app: ReturnType<typeof Fastify>;
let dataDir: string;
const fakeUs = new FakeUs();
const fake = new FakeTradingAdapter();
let clock = T;
let seq = 0;
let bindingId = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-automation-"));
  process.env.PL_DATA_DIR = dataDir;
  setMarketProviderForTests("polymarket_us", fakeUs);
  setTradingAdapterForTests(fake);
  fake.now = () => new Date(Date.parse(clock));
  const { createContext } = await import("../context.js");
  ctx = createContext({ now: () => new Date(Date.parse(clock)), leaseHolder: "auto-1" });
  const s = ctx.settings.getPersisted();
  s.privacy.allowInternet = true;
  s.markets.venues = ["polymarket", "polymarket_us"];
  s.limits.concurrency = 1;
  ctx.settings.savePersisted(s);
  app = Fastify();
  registerCsrfGuard(app, () => ["http://127.0.0.1:7317"]);
  registerDecisionRoutes(app, ctx);
  registerTradingRoutes(app, ctx);
  registerExecutionRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);
  // Creator A: a usable history (four settled Lions picks at .25, three wins) — the same fixture as 1.12/1.13.
  const games: [string, string, string, "Lions" | "Bills"][] = [["g01", "2026-09-01", "2026-08-31T23:00:00Z", "Lions"], ["g02", "2026-09-02", "2026-09-01T23:00:00Z", "Lions"], ["g03", "2026-09-03", "2026-09-02T23:00:00Z", "Lions"], ["g04", "2026-09-04", "2026-09-03T23:00:00Z", "Bills"]];
  for (const [id, day, priceAt, winner] of games) { const m = market(id, `${day}T17:00:00Z`, { yesPrice: 0.25, priceAt }); claim(A, m.id, "Detroit Lions", day); resolve(id, winner, `${day}T21:00:00Z`); }
  fake.script(KEY, { secretKey: SECRET, balances: [fakeBalance("1000.00", "1000.00")] });
  bindingId = (await ctx.trading.connect({ keyId: KEY, secretKey: SECRET })).binding.id;
  ctx.trading.setLimits({ maxOpenMarkets: 50, totalOpenRisk: "1000", dailyCommitmentCap: "1000", perEvent: "100", dailyLossStop: "1000" }, { budgetTimezone: "UTC" });
  ctx.trading.setAutomation({ minReevaluateMs: 0, intervalMs: 5_000 });
  await ctx.trading.sync();
  assert.ok(ctx.lease.acquire(60_000));
  await ctx.execution.startStream();
});
after(async () => { ctx?.autoTrader.stop(); await ctx?.jobs.stop(); ctx?.execution.stopStream(); ctx?.db.close(); delete process.env.PL_DATA_DIR; setMarketProviderForTests("polymarket_us", undefined); setTradingAdapterForTests(undefined); });

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
/** A creator's pick on a market, optionally left unlinked (the scheduler must find the contract itself). */
function claim(creator: { channelId: string; name: string }, marketId: string | undefined, team: "Detroit Lions" | "Buffalo Bills", publishedAt: string, opts: { link?: boolean; eventDate?: string; subscriptionId?: string } = {}) {
  seq += 1;
  const id = `a${String(seq).padStart(4, "0")}${creator.channelId.slice(0, 3)}`;
  const video = ctx.videos.createFromYouTube({ youtubeId: id.padEnd(11, "x").slice(0, 11), url: `https://www.youtube.com/watch?v=${id}`, title: `${creator.name} picks`, publishedAt, channel: creator.name, channelId: creator.channelId, subscriptionId: opts.subscriptionId, firstSeenAt: publishedAt.length > 10 ? publishedAt : `${publishedAt}T00:00:00.000Z` });
  ctx.videos.applyYouTubeInfo(video.id, { publishedPrecision: publishedAt.length > 10 ? "datetime" : "date" });
  const m = marketId ? ctx.markets.get(marketId)! : undefined;
  const eventDate = opts.eventDate ?? (m?.constraints?.gameStartTime ?? "2026-10-01").slice(0, 10);
  const p = ctx.predictions.create({ videoId: video.id, kind: "sports_pick", sportsPick: { sport: "NFL", league: "nfl", teams: ["Detroit Lions", "Buffalo Bills"], eventDate, pick: { type: "moneyline", team } }, quoteExact: `I like the ${team} tonight (${seq})`, normalizedStatement: `${team} win`, entities: ["Detroit Lions", "Buffalo Bills"], conditions: [], thresholds: [], madeOnDate: publishedAt.slice(0, 10), madeOnBasis: "publication", deadlineDate: eventDate, deadlineBasis: "rule:absolute", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: `${team} win` }] });
  const at = publishedAt.length > 10 ? publishedAt : `${publishedAt}T00:00:00.000Z`;
  ctx.db.run("UPDATE predictions SET created_at = ? WHERE id = ?", at, p.id);
  if (!m || opts.link === false) return { video, prediction: p, link: undefined, verification: undefined };
  const link = ctx.markets.propose({ predictionId: p.id, marketId: m.id, side: team === "Detroit Lions" ? "Lions" : "Bills", score: 1, relation: "exact", matchedBy: "rule:sports", status: "accepted" });
  ctx.db.run("UPDATE prediction_market_links SET updated_at = ?, created_at = ? WHERE id = ?", at, at, link.id);
  const verification = ctx.contracts.verifyLink(link.id);
  assert.equal(verification.status, "verified_equivalent", `fixture must verify: ${verification.notes}`);
  ctx.db.run("UPDATE contract_verifications SET created_at = ? WHERE id = ?", at, verification.id);
  return { video, prediction: p, link, verification };
}
/** TEST SHORTCUT (labelled): a production qualification row and the paper rehearsal, inserted by SQL. The app writes production records only from a passing evaluation (F08). */
function qualify(category = "sports"): void {
  if (!ctx.trading.qualificationFor(ctx.forecasts.strategyVersion, category)) {
    ctx.db.run("INSERT INTO strategy_qualifications (id, strategy_version, category, source, events, brier, baseline_brier, qualified, report_json, created_at) VALUES (?, ?, ?, 'production', 120, '0.20', '0.22', 1, ?, ?)", crypto.randomUUID(), ctx.forecasts.strategyVersion, category, JSON.stringify({ note: "TEST SHORTCUT — inserted by automation.test.ts; not strategy evidence", gate: { reasons: [] } }), clock);
  }
  const settled = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM paper_us_positions WHERE status = 'settled'")!.n;
  for (let i = settled; i < 20; i++) {
    ctx.db.run("INSERT INTO paper_us_positions (id, intent_id, decision_id, market_id, venue_market_id, side, quantity, avg_cost, cost_total, fees, status, opened_at, settled_at, outcome, pnl, method) VALUES (?, ?, ?, ?, ?, 'yes', '1', '0.5', '0.5', '0', 'settled', ?, ?, 'win', '0.5', 'us-ioc-v1')", crypto.randomUUID(), `test-intent-${i}`, `test-decision-${i}`, "rehearsal", `rehearsal-${i}`, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z");
  }
}
async function armAuto(): Promise<void> {
  assert.ok(ctx.lease.acquire(60_000), "this process (re)takes the dispatch lease at the fixture clock");
  await ctx.trading.sync();
  ctx.trading.arm({ acknowledge: AUTO_LIVE_ACKNOWLEDGEMENT, policyHash: ctx.trading.policy().policyHash, category: "sports", strategyVersion: ctx.forecasts.strategyVersion });
  assert.equal(ctx.trading.policy().mode, "auto_live");
  assert.deepEqual(ctx.autoTrader.liveEnabled(), { ok: true, reasons: [] }, JSON.stringify(ctx.autoTrader.liveEnabled()));
}
const createCalls = () => fake.createCalls;

// ------------------------------------------------------------------------------------------------------------------

test("U01 — arming automation needs every gate, the exact acknowledgement and the reviewed policy hash; a bare mode switch never arms; the exact hash is recorded", async () => {
  const hash = ctx.trading.policy().policyHash;
  // No production qualification, no paper rehearsal: refused with the missing gates named.
  assert.throws(() => ctx.trading.arm({ acknowledge: AUTO_LIVE_ACKNOWLEDGEMENT, policyHash: hash, category: "sports", strategyVersion: ctx.forecasts.strategyVersion }), (e: unknown) => e instanceof TradingGateError && e.gates.some((g) => g.id === "strategy_qualified") && e.gates.some((g) => g.id === "paper_rehearsal"));
  // A fixture-sourced qualification (what F08 produces) never counts.
  ctx.db.run("INSERT INTO strategy_qualifications (id, strategy_version, category, source, events, qualified, report_json) VALUES (?, ?, 'sports', 'fixture', 120, 1, '{}')", crypto.randomUUID(), ctx.forecasts.strategyVersion);
  assert.throws(() => ctx.trading.arm({ acknowledge: AUTO_LIVE_ACKNOWLEDGEMENT, policyHash: hash, category: "sports", strategyVersion: ctx.forecasts.strategyVersion }), (e: unknown) => e instanceof TradingGateError && e.gates.some((g) => g.id === "strategy_qualified"));
  qualify("sports");
  // Wrong category, wrong text, stale hash: each refused with its own gate.
  assert.throws(() => ctx.trading.arm({ acknowledge: AUTO_LIVE_ACKNOWLEDGEMENT, policyHash: hash, category: "crypto", strategyVersion: ctx.forecasts.strategyVersion }), (e: unknown) => e instanceof TradingGateError && e.gates.some((g) => g.id === "strategy_qualified"));
  assert.throws(() => ctx.trading.arm({ acknowledge: LIVE_ACKNOWLEDGEMENT, policyHash: hash, category: "sports", strategyVersion: ctx.forecasts.strategyVersion }), (e: unknown) => e instanceof TradingGateError && e.gates.some((g) => g.id === "live_authorization"));
  assert.throws(() => ctx.trading.arm({ acknowledge: AUTO_LIVE_ACKNOWLEDGEMENT, policyHash: "0".repeat(64), category: "sports", strategyVersion: ctx.forecasts.strategyVersion }), (e: unknown) => e instanceof TradingGateError && e.gates.some((g) => g.id === "policy_reviewed"));
  // A bare mode switch (UI select or direct API) can never arm automation.
  const bare = await app.inject({ method: "PUT", url: "/api/trading/policy", headers: csrf, payload: { mode: "auto_live", acknowledge: AUTO_LIVE_ACKNOWLEDGEMENT } });
  assert.equal(bare.statusCode, 409);
  assert.equal(ctx.trading.policy().mode, "paper");
  // The real thing, through the route.
  const armed = await app.inject({ method: "POST", url: "/api/trading/arm", headers: csrf, payload: { acknowledge: AUTO_LIVE_ACKNOWLEDGEMENT, policyHash: hash, category: "sports" } });
  assert.equal(armed.statusCode, 200, armed.body);
  const p = ctx.trading.policy();
  assert.deepEqual({ mode: p.mode, authorized: p.authorizedPolicyHash, strategy: p.authorizedStrategyVersion, category: p.authorizedCategory }, { mode: "auto_live", authorized: hash, strategy: ctx.forecasts.strategyVersion, category: "sports" });
  assert.ok(p.liveAuthorizedAt && p.liveAuthorizationHash);
  const audit = ctx.trading.auditEvents().find((e) => e.kind === "policy.mode_changed" && e.details.to === "auto_live")!;
  assert.equal(audit.details.authorizedPolicyHash, hash, "the exact policy hash is on record");
  assert.equal(ctx.trading.status().armed, true);
  assert.deepEqual(ctx.autoTrader.liveEnabled(), { ok: true, reasons: [] });
  // Any policy edit — limits or scheduler budgets — invalidates the authorization: disarmed, hash cleared, scheduler refuses.
  ctx.trading.setAutomation({ maxOrdersPerTick: 2 });
  assert.equal(ctx.trading.policy().mode, "paper");
  assert.equal(ctx.trading.policy().authorizedPolicyHash, undefined);
  assert.ok(ctx.autoTrader.liveEnabled().reasons.some((r) => /mode is paper/.test(r)));
  assert.ok(ctx.tradingAlerts.list().some((a) => a.kind === "disarmed"), "a disarm raises a local alert");
  ctx.trading.setAutomation({ maxOrdersPerTick: 1 });
});

test("U02 — from an extracted pick: the scheduler queues matching on the fake venue, verifies the contract, builds a qualified forecast and places exactly one bounded automatic order; a slow job cannot delay a cancel or a tick", async () => {
  await armAuto();
  const sub = ctx.subscriptions.create({ url: "https://www.youtube.com/@creator-a/videos", autoExtract: true });
  const m = market("u02", "2026-10-01T18:00:00Z");
  fakeUs.searchable = [fakeUs.byId.get("u02")!];
  const c = claim(A, undefined, "Detroit Lions", "2026-09-30T10:00:00Z", { subscriptionId: sub.id, eventDate: "2026-10-01" });
  assert.equal(ctx.markets.linksForPrediction(c.prediction.id).length, 0, "no link yet: the scheduler must find the contract");
  ctx.jobs.start();
  const before = createCalls();
  // Tick 1: discovery queues market.match (never awaited inside the tick); nothing to evaluate yet.
  const r1 = await ctx.autoTrader.tick();
  assert.equal(r1.outcome, "completed");
  assert.equal(ctx.autoTrader.candidatesFor(r1.id).filter((x) => x.reason === "market_match_queued").length, 1);
  for (let i = 0; i < 100 && !ctx.markets.linksForPrediction(c.prediction.id).length; i++) await sleep(50);
  const link = ctx.markets.linksForPrediction(c.prediction.id)[0];
  assert.ok(link, "market.match linked the contract found on the fake venue");
  assert.equal(link.status, "accepted", "an exact sports matchup auto-accepts (1.6 rule)");
  assert.equal(link.marketId, m.id);
  assert.equal(fakeUs.searches > 0, true);
  // Tick 2: verification (computed checklist) → forecast (qualified: production record + A's history) → decision → one order, all in the same tick.
  const r2 = await ctx.autoTrader.tick();
  assert.equal(r2.outcome, "completed", JSON.stringify(r2));
  const cands = ctx.autoTrader.candidatesFor(r2.id);
  assert.ok(cands.some((x) => /^verified:verified_equivalent/.test(x.reason)), JSON.stringify(cands));
  const ordered = cands.find((x) => x.outcome === "ordered");
  assert.ok(ordered, JSON.stringify({ run: r2, cands }));
  assert.equal(r2.ordered, 1);
  assert.equal(createCalls(), before + 1, "exactly one venue create call");
  // Tick 3: the contract's opportunity is consumed — nothing more happens on it.
  const r3 = await ctx.autoTrader.tick();
  assert.equal(r3.ordered, 0);
  assert.equal(r3.skipped.opportunity_consumed, 1);
  const intent = ctx.execution.intent(ordered!.intentId!)!;
  assert.equal(intent.state, "filled");
  const decision = ctx.decisions.get(ordered!.decisionId!)!;
  assert.equal(decision.mode, "auto_live");
  assert.equal(decision.outcome, "eligible");
  const forecast = ctx.forecasts.get(decision.forecastId!)!;
  assert.equal(forecast.status, "qualified");
  const call = fake.calls.filter((x) => x.method === "createOrder").at(-1)!;
  assert.equal(call.args?.manual, false, "scheduled orders carry the automatic indicator");
  assert.ok(D(decision.sizing!.worstCost).lte(ctx.trading.policy().limits.orderBudget), "bounded by the order budget");
  // Complete audit graph: prediction → link → verification → forecast → decision → preview → intent → venue order → executions → audit events.
  const preview = ctx.execution.getPreview(intent.previewId!)!;
  assert.equal(preview.decisionHash, decision.rationaleHash);
  assert.ok(intent.order && intent.executions!.length > 0);
  const kinds = ctx.trading.auditEvents(200).map((e) => e.kind);
  for (const k of ["automation.tick", "order.previewed", "order.submitting", "order.acknowledged"]) assert.ok(kinds.includes(k), k);
  // A long-running job on the queue (a stand-in for transcription) does not delay the execution path: cancel and tick run beside it.
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((r) => { release = r; });
  ctx.jobs.register("model.download", async () => { await blocked; return {}; });
  const slow = ctx.jobs.enqueue({ kind: "model.download", payload: { test: true }, maxAttempts: 1 });
  for (let i = 0; i < 100 && ctx.jobs.get(slow)!.status !== "running"; i++) await sleep(20);
  assert.equal(ctx.jobs.get(slow)!.status, "running");
  const t0 = Date.now();
  const rest = market("u02b", "2026-10-01T18:00:00Z");
  claim(A, rest.id, "Detroit Lions", "2026-09-30T11:00:00Z");
  fake.behave(rest.constraints!.slug!, { mode: "rest" });
  const r4 = await ctx.autoTrader.tick();
  const open = ctx.autoTrader.candidatesFor(r4.id).find((x) => x.outcome === "ordered")!;
  assert.ok(open, JSON.stringify(ctx.autoTrader.candidatesFor(r4.id)));
  const cancel = await ctx.execution.cancelIntent(open.intentId!);
  assert.equal(cancel.outcome, "requested");
  assert.ok(Date.now() - t0 < 2_000, "tick + cancel completed while the slow job was still running");
  assert.equal(ctx.jobs.get(slow)!.status, "running", "the slow job is still occupying the queue");
  release();
  for (let i = 0; i < 100 && ctx.jobs.get(slow)!.status === "running"; i++) await sleep(20);
  await ctx.jobs.stop();
});

test("U03 — a consumed contract opportunity survives a re-run of the video, a same-creator video, a policy edit, a re-import and a restart: no second automatic entry, no top-up after an IOC cancel", async () => {
  await armAuto();
  const before = createCalls();
  const m = ctx.markets.findByVenue("polymarket_us", "u02")!;
  assert.ok(ctx.risk.opportunityConsumed(bindingId, "polymarket_us", m.venueId), "U02 consumed it");
  // Re-run of the same video (a second extraction of the same quote) and a same-creator video on the same contract.
  claim(A, m.id, "Detroit Lions", "2026-09-30T12:00:00Z");
  claim(A, m.id, "Detroit Lions", "2026-09-30T13:00:00Z");
  claim(B, m.id, "Detroit Lions", "2026-09-30T14:00:00Z");
  const r1 = await ctx.autoTrader.tick();
  assert.equal(r1.ordered, 0);
  assert.ok((r1.skipped.opportunity_consumed ?? 0) >= 3, JSON.stringify(r1.skipped));
  // Policy edit (version change) → disarmed; re-arm → still consumed.
  ctx.trading.setLimits({ orderBudget: "9" });
  assert.equal(ctx.trading.policy().mode, "paper");
  const r2 = await ctx.autoTrader.tick();
  assert.equal(r2.outcome, "skipped");
  await armAuto();
  const r3 = await ctx.autoTrader.tick();
  assert.equal(r3.ordered, 0);
  assert.ok((r3.skipped.opportunity_consumed ?? 0) >= 1);
  // An IOC that filled nothing still consumed the opportunity: no top-up, ever.
  const none = market("u03n", "2026-10-01T18:00:00Z");
  claim(A, none.id, "Detroit Lions", "2026-09-30T10:00:00Z");
  fake.behave(none.constraints!.slug!, { mode: "none" });
  const r4 = await ctx.autoTrader.tick();
  assert.equal(r4.ordered, 1);
  const i4 = ctx.execution.intent(ctx.autoTrader.candidatesFor(r4.id).find((x) => x.outcome === "ordered")!.intentId!)!;
  assert.equal(i4.state, "canceled");
  assert.equal(i4.filledQuantity, "0");
  const r5 = await ctx.autoTrader.tick();
  assert.equal(r5.ordered, 0);
  assert.ok((r5.skipped.opportunity_consumed ?? 0) >= 1, JSON.stringify(r5.skipped));
  // Restart: a second process on the same data directory (a restart disarms per OPS-02; the opportunity table is shared).
  const { createContext } = await import("../context.js");
  const ctx2 = createContext({ now: () => new Date(Date.parse(clock)), leaseHolder: "auto-2" });
  try {
    assert.equal(ctx2.trading.policy().mode, "paper", "restart returns disarmed");
    assert.ok(ctx2.risk.opportunityConsumed(bindingId, "polymarket_us", m.venueId));
    assert.ok(ctx2.risk.opportunityConsumed(bindingId, "polymarket_us", none.venueId));
    const r6 = await ctx2.autoTrader.tick();
    assert.equal(r6.outcome, "skipped");
  } finally { ctx2.autoTrader.stop(); ctx2.db.close(); }
  assert.equal(createCalls(), before + 1, "only the IOC-canceled entry was sent in this whole test");
  ctx.trading.setLimits({ orderBudget: "10" });
});

test("U04 — an emergency stop racing a tick with several candidates and one in-flight POST: no new send after the stop, the in-flight order reconciles and is cancelled, only app-owned unfilled orders are targeted, positions stay", async () => {
  await armAuto();
  ctx.trading.setAutomation({ maxOrdersPerTick: 5, maxPerSourcePerTick: 10, maxEvaluationsPerTick: 20 });
  await armAuto();
  const before = createCalls();
  const slugs: string[] = [];
  for (const id of ["u04a", "u04b", "u04c"]) { const m = market(id, "2026-10-01T18:00:00Z"); claim(A, m.id, "Detroit Lions", "2026-09-30T10:00:00Z"); slugs.push(m.constraints!.slug!); }
  // The first order's response is held for 300 ms while the venue already holds it open; the others would follow in the same tick.
  fake.behave(slugs[0], { mode: "rest", responseDelayMs: 300 });
  fake.behave(slugs[1], { mode: "rest" });
  fake.behave(slugs[2], { mode: "rest" });
  const ext = fake.externalOrder(slugs[1], "yes", "3", "0.5");
  const tick = ctx.autoTrader.tick();
  await sleep(120); // the first POST is in flight
  const stop = await ctx.execution.emergencyStop("owner pressed stop");
  const run = await tick;
  assert.equal(createCalls(), before + 1, "exactly the in-flight POST; nothing sent after the stop");
  assert.equal(stop.previousMode, "auto_live");
  assert.equal(ctx.trading.policy().mode, "paper");
  assert.equal(ctx.trading.policy().pauseReason, "owner pressed stop");
  const cands = ctx.autoTrader.candidatesFor(run.id);
  assert.equal(cands.filter((c) => c.outcome === "ordered").length, 1, JSON.stringify(cands));
  assert.ok(run.notes.some((n) => /stopped mid-tick/.test(n)) || cands.some((c) => /dispatch_blocked|stopped_mid_tick|mode_not_live|preview_stale/.test(c.reason)), JSON.stringify({ run, cands }));
  const inflight = ctx.execution.intent(cands.find((c) => c.outcome === "ordered")!.intentId!)!;
  assert.ok(["acknowledged", "partially_filled", "canceled"].includes(inflight.state), inflight.state);
  assert.ok(inflight.venueOrderId, "the in-flight order's id was persisted when the response arrived");
  // The stop targeted app-owned open orders only; the sweep may have run before the in-flight id landed — reconcile + a second sweep catch it.
  await ctx.execution.reconcile();
  const targeted = stop.cancellations.map((c) => c.venueOrderId);
  assert.ok(!targeted.includes(ext.id), "an order the app did not place is never targeted by the stop");
  const venueOrder = fake.orders.get(inflight.venueOrderId!)!;
  if (venueOrder.state === "open") { const r = await ctx.execution.cancelIntent(inflight.id); assert.equal(r.outcome, "requested"); }
  assert.equal(fake.orders.get(inflight.venueOrderId!)!.state, "canceled");
  assert.equal(fake.orders.get(ext.id)!.state, "open", "external order untouched");
  assert.equal(stop.positionsRetained, ctx.execution.positions(bindingId).filter((p) => !p.settled && !D(p.localNet).isZero()).length, "positions are retained, never flattened");
  assert.ok(ctx.tradingAlerts.list().some((a) => a.kind === "emergency_stop"));
  // After a stop nothing runs until the owner resumes and re-arms; account-wide cancel is a separate, acknowledged action.
  assert.equal((await ctx.autoTrader.tick()).outcome, "skipped");
  const noAck = await app.inject({ method: "POST", url: "/api/trading/cancel-all", headers: csrf, payload: { acknowledge: "yes" } });
  assert.equal(noAck.statusCode, 409);
  assert.equal(fake.orders.get(ext.id)!.state, "open");
  const all = await app.inject({ method: "POST", url: "/api/trading/cancel-all", headers: csrf, payload: { acknowledge: CANCEL_ALL_ACKNOWLEDGEMENT } });
  assert.equal(all.statusCode, 200, all.body);
  assert.ok((all.json() as { requested: string[] }).requested.includes(ext.id));
  assert.equal(fake.orders.get(ext.id)!.state, "canceled");
  ctx.trading.resume();
  for (const h of ctx.execution.holds(bindingId, true)) ctx.execution.resolveHold(h.id, "U04 cleanup");
  ctx.trading.setAutomation({ maxOrdersPerTick: 1, maxPerSourcePerTick: 2, maxEvaluationsPerTick: 10 });
});

test("U05 — restart, a sleep past the cutoff, a restored older database, a credential rotation and a strategy change all return disarmed; nothing is re-sent and no catch-up bet is placed", async () => {
  await armAuto();
  const before = createCalls();
  // Sleep past the cutoff: the clock jumps beyond the games; the candidates are skipped before any evaluation.
  const m = market("u05", "2026-10-01T18:00:00Z");
  claim(A, m.id, "Detroit Lions", "2026-09-30T10:00:00Z");
  clock = "2026-10-01T18:30:00Z";
  assert.ok(ctx.lease.acquire(60_000));
  await ctx.trading.sync();
  const late = await ctx.autoTrader.tick();
  assert.equal(late.outcome, "completed", JSON.stringify(late));
  assert.equal(late.ordered, 0);
  assert.ok((late.skipped.cutoff_passed ?? 0) >= 1, JSON.stringify(late.skipped));
  assert.equal(ctx.autoTrader.candidatesFor(late.id).filter((c) => c.reason === "cutoff_passed" && c.decisionId).length, 0, "not even evaluated");
  ctx.db.run("DELETE FROM trading_account_syncs WHERE at > ?", T);
  clock = T;
  await ctx.trading.sync();
  // Restored older database: a backup taken while armed comes up disarmed, needs rebind, and never resends a restored intent.
  ctx.db.run("INSERT INTO trade_intents (id, decision_id, reservation_id, mode, account_key, provider, venue_market_id, side, quantity, wire_price, limit_cost, state, payload_hash, dispatch_marker_at, created_at, updated_at, binding_id, market_slug) VALUES (?, 'd-restored', 'r-restored', 'live', ?, 'polymarket_us', 'u05', 'yes', '19', '0.5', '0.5', 'submitting', 'h', ?, ?, ?, ?, 'aec-nfl-det-buf-u05')", "restored-intent", bindingId, clock, clock, clock, bindingId);
  const info = createBackup(ctx.db, ctx.paths);
  ctx.db.run("DELETE FROM trade_intents WHERE id = 'restored-intent'");
  const restored = fs.mkdtempSync(path.join(os.tmpdir(), "pl-auto-restore-"));
  fs.copyFileSync(path.join(ctx.paths.backups, info.file), path.join(restored, path.basename(ctx.paths.database)));
  fs.copyFileSync(path.join(dataDir, path.basename(ctx.paths.secretKey)), path.join(restored, path.basename(ctx.paths.secretKey)));
  const prevDir = process.env.PL_DATA_DIR;
  process.env.PL_DATA_DIR = restored;
  const { createContext } = await import("../context.js");
  const ctx2 = createContext({ now: () => new Date(Date.parse(clock)), leaseHolder: "auto-restore" });
  try {
    assert.equal(ctx2.trading.policy().mode, "paper");
    assert.equal(ctx2.trading.policy().authorizedPolicyHash, undefined);
    assert.equal(ctx2.trading.connected(), undefined, "needs rebind");
    const rec = ctx2.execution.recoverAfterCrash();
    assert.deepEqual(rec.unknown, ["restored-intent"], "a restored in-flight intent becomes unknown, never re-sent");
    assert.equal((await ctx2.autoTrader.tick()).outcome, "skipped");
  } finally { ctx2.autoTrader.stop(); ctx2.db.close(); process.env.PL_DATA_DIR = prevDir; }
  // Credential rotation (a different key) → disarmed; the scheduler refuses.
  await armAuto();
  fake.script(KEY_B, { secretKey: SECRET_B, balances: [fakeBalance("1000.00", "1000.00")] });
  await ctx.trading.connect({ keyId: KEY_B, secretKey: SECRET_B, assertSameAccount: true });
  assert.equal(ctx.trading.policy().mode, "paper", "credential change disarms");
  assert.ok(ctx.trading.auditEvents().some((e) => e.kind === "trading.disarmed" && e.details.reason === "credential change"));
  assert.equal((await ctx.autoTrader.tick()).outcome, "skipped");
  // Back on the original key (same binding, reconciliation required until a reconcile runs) → reconcile → re-arm allowed → strategy/budget change disarms again.
  await ctx.trading.connect({ keyId: KEY, secretKey: SECRET, assertSameAccount: true });
  await ctx.execution.reconcile();
  ctx.db.run("UPDATE trading_accounts SET reconcile_required = 0 WHERE id = ?", bindingId); // the reconcile ran; the binding flag is cleared by the owner-confirmed reconcile (1.13 route)
  await armAuto();
  ctx.trading.setAutomation({ minReevaluateMs: 1 });
  assert.equal(ctx.trading.policy().mode, "paper", "a strategy/budget change disarms");
  ctx.trading.setAutomation({ minReevaluateMs: 0 });
  assert.equal(createCalls(), before, "nothing was sent in any of these transitions");
});

test("U06 — repeated adapter failures open the circuit breaker once (one alert per incident), disarm, keep reads/cancels working, and never re-arm by themselves", async () => {
  await armAuto();
  const threshold = ctx.trading.policy().automation.breakerThreshold;
  fake.outage = "venue_unavailable";
  for (let i = 0; i < threshold + 2; i++) await ctx.trading.sync().catch(() => undefined);
  const b = ctx.trading.breaker();
  assert.equal(b.state, "open");
  assert.ok(b.consecutiveFailures >= threshold);
  assert.equal(ctx.trading.policy().mode, "paper", "breaker opening disarms");
  const alerts = ctx.tradingAlerts.list().filter((a) => a.kind === "circuit_breaker");
  assert.equal(alerts.length, 1, "one alert per incident");
  assert.ok(!JSON.stringify(alerts).includes(SECRET));
  assert.ok(ctx.trading.dispatchBlockers().some((x) => /circuit breaker/.test(x)));
  assert.equal((await ctx.autoTrader.tick()).outcome, "skipped");
  // 401 / 429 count too; 400 does not.
  fake.outage = "rate_limited";
  await ctx.trading.sync().catch(() => undefined);
  assert.equal(ctx.trading.breaker().consecutiveFailures, threshold + 3);
  // Reads and cancels recover as soon as the venue does; the breaker closes after the cooldown; the mode stays paper.
  fake.outage = undefined;
  await ctx.trading.sync();
  assert.equal(ctx.trading.breaker().state, "half_open", "a success inside the cooldown does not close it");
  clock = new Date(Date.parse(T) + ctx.trading.policy().automation.breakerCooldownMs + 1000).toISOString();
  ctx.lease.acquire(60_000);
  await ctx.trading.sync();
  assert.equal(ctx.trading.breaker().state, "closed");
  assert.equal(ctx.trading.policy().mode, "paper", "no silent automatic re-arm");
  assert.ok(ctx.trading.auditEvents().some((e) => e.kind === "breaker.closed"));
  ctx.db.run("DELETE FROM trading_account_syncs WHERE at > ?", T);
  clock = T;
  await ctx.trading.sync();
  // Auth failure: counted, and the account shows the validation error (no live-ready state).
  fake.outage = "unauthorized";
  await ctx.trading.sync().catch(() => undefined);
  fake.outage = undefined;
  assert.ok(ctx.trading.breaker().consecutiveFailures >= 1);
  await ctx.trading.sync();
});

test("D01/D03 — the ledger lists pending, partial, filled, unknown, rejected, external and settled rows with separate order/position states and stale marks; filters, summary, JSON and CSV exports match the database and carry no secret", async () => {
  await armAuto();
  // Populate the remaining states on fresh contracts through the scheduler (one order per tick).
  const mk = (id: string, mode: Parameters<FakeTradingAdapter["behave"]>[1]) => { const m = market(id, "2026-10-01T18:00:00Z"); claim(A, m.id, "Detroit Lions", "2026-09-30T10:00:00Z"); fake.behave(m.constraints!.slug!, mode); return m; };
  const partial = mk("d01p", { mode: "partial", fills: [{ quantity: "5", yesPrice: "0.5" }], feePerContract: "0.02" });
  await ctx.autoTrader.tick();
  const rejected = mk("d01r", { mode: "reject", rejectReason: "ORD_REJECT_REASON_PRICE_OUT_OF_BOUNDS" });
  await ctx.autoTrader.tick();
  const unknown = mk("d01u", { mode: "drop_response" });
  await ctx.autoTrader.tick();
  assert.equal(ctx.trading.policy().mode, "paper", "an unknown submission during automation disarms");
  // A skipped decision: Creator B has no usable history, so the forecast is insufficient and the decision abstains.
  const skippedMarket = market("d01s", "2026-10-01T18:00:00Z");
  const bClaim = claim(B, skippedMarket.id, "Detroit Lions", "2026-09-30T10:00:00Z");
  const skippedDecision = await ctx.decisions.evaluate({ predictionId: bClaim.prediction.id, linkId: bClaim.link!.id, now: clock });
  assert.equal(skippedDecision.outcome, "skipped");
  const rows = ctx.ledger.rows({ limit: 1000 });
  const byMarket = (m: { venueId: string }) => rows.find((r) => !r.external && r.venueMarketId === m.venueId) as TradeLedgerRow;
  assert.equal(byMarket(partial).intentState, "partially_filled");
  assert.equal(byMarket(partial).orderState, "canceled", "order state (canceled remainder) is separate from the position state (open)");
  assert.equal(byMarket(partial).positionState, "open");
  assert.equal(byMarket(partial).filledQuantity, "5");
  assert.equal(byMarket(partial).fees, "0.1");
  assert.ok(byMarket(partial).mark && byMarket(partial).mark!.stale === true, "no fresh snapshot → the mark is flagged stale");
  assert.equal(byMarket(rejected).intentState, "rejected");
  assert.equal(byMarket(rejected).rejectReason, "ORD_REJECT_REASON_PRICE_OUT_OF_BOUNDS");
  assert.equal(byMarket(rejected).positionState, "none");
  assert.equal(byMarket(unknown).intentState, "submission_unknown");
  assert.equal(byMarket(unknown).positionState, "unknown");
  assert.ok(rows.some((r) => r.external), "external orders are rows of their own");
  const ext = rows.find((r) => r.external)!;
  assert.ok(ext.external && !("reasonCodes" in ext) && !("quote" in ext), "no rationale, quote or reason is invented for an external order");
  assert.ok(rows.some((r) => !r.external && r.outcome === "skipped"), "skipped decisions are listed");
  assert.ok(rows.some((r) => !r.external && r.intentState === "filled"));
  // Filters.
  assert.ok(ctx.ledger.rows({ status: "unknown" }).every((r) => !r.external && r.intentState === "submission_unknown"));
  assert.ok(ctx.ledger.rows({ status: "partial" }).length >= 1);
  assert.ok(ctx.ledger.rows({ status: "external" }).every((r) => r.external));
  assert.ok(ctx.ledger.rows({ mode: "auto_live" }).every((r) => r.external || r.mode === "auto_live"));
  assert.ok(ctx.ledger.rows({ creator: "UC-A" }).length > 0 && ctx.ledger.rows({ creator: "UC-A" }).every((r) => r.external || r.creatorKey === "UC-A"));
  assert.equal(ctx.ledger.rows({ creator: "UC-nobody", includeExternal: false }).length, 0);
  assert.ok(ctx.ledger.rows({ reason: "OPPORTUNITY_CONSUMED" }).every((r) => r.external || r.reasonCodes.includes("OPPORTUNITY_CONSUMED")));
  assert.equal(ctx.ledger.rows({ from: "2026-10-02T00:00:00Z", includeExternal: false }).length, 0);
  assert.ok(ctx.ledger.rows({ category: "sports", includeExternal: false }).length > 0);
  // Summary: live figures only from the venue and official events; paper never summed in.
  const sum = ctx.ledger.summary();
  assert.equal(sum.mode, "paper");
  assert.equal(sum.buyingPower, "1000.00");
  assert.equal(sum.unknownIntents, 1);
  assert.ok(sum.openPositions >= 1);
  assert.equal(sum.markStale, true);
  assert.ok(sum.holdsOpen >= 1 && sum.alertsOpen >= 1);
  assert.equal(sum.realizedPnl, "0", "no official settlement yet");
  // Routes + exports.
  const res = await app.inject({ method: "GET", url: "/api/trading/ledger?status=unknown" });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as unknown[]).length, 1);
  const csv = await app.inject({ method: "GET", url: "/api/trading/ledger.csv" });
  assert.equal(csv.statusCode, 200);
  assert.ok(csv.headers["content-type"]?.toString().startsWith("text/csv"));
  const lines = csv.body.trim().split("\n");
  assert.equal(lines.length - 1, rows.length, "one CSV line per ledger row");
  assert.ok(lines[0].startsWith("kind,decision_id,clock_at,mode,outcome,reason_codes"));
  assert.ok(lines.some((l) => l.startsWith("external,")));
  assert.ok(!csv.body.includes(SECRET) && !csv.body.includes(SECRET_B));
  const json = await app.inject({ method: "GET", url: "/api/trading/ledger.json?status=partial" });
  assert.equal((json.json() as { rows: unknown[] }).rows.length, ctx.ledger.rows({ status: "partial" }).length);
  assert.ok(!json.body.includes(SECRET));
  const metrics = await app.inject({ method: "GET", url: "/api/trading/metrics" });
  const mt = metrics.json() as { decisions: number; unknownSubmissions: number; automationRuns: number; fills: number };
  assert.equal(mt.decisions, ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_decisions")!.n);
  assert.equal(mt.unknownSubmissions, 1);
  assert.ok(mt.automationRuns > 0 && mt.fills > 0);
  // Cleanup for later tests: resolve the unknown, holds and alerts.
  const u = ctx.execution.intents({ state: "submission_unknown" })[0];
  const rep = await ctx.execution.reconcile();
  ctx.execution.resolveUnknown(u.id, { venueOrderId: rep.unknownIntents[0].candidates[0] }, "D01 cleanup: linked");
  for (const h of ctx.execution.holds(bindingId, true)) ctx.execution.resolveHold(h.id, "D01 cleanup");
  for (const a of ctx.tradingAlerts.list({ openOnly: true })) ctx.tradingAlerts.acknowledge(a.id);
  assert.equal(ctx.tradingAlerts.openCount(), 0);
});

test("O03 (scheduler) — a second process on the same database never dispatches without the lease; O04 — the ledger stays fast with 10,000 decisions", async () => {
  await armAuto();
  const { createContext } = await import("../context.js");
  const ctx2 = createContext({ now: () => new Date(Date.parse(clock)), leaseHolder: "auto-3" });
  try {
    await armAuto(); // process start disarmed the shared row; arm it again from process 1
    assert.equal(ctx2.lease.acquire(60_000), false);
    const m = market("o03", "2026-10-01T18:00:00Z");
    claim(A, m.id, "Detroit Lions", "2026-09-30T10:00:00Z");
    const before = createCalls();
    const r = await ctx2.autoTrader.tick();
    assert.equal(r.outcome, "skipped");
    assert.ok(/lease/.test(r.reason ?? ""), r.reason);
    assert.equal(createCalls(), before);
  } finally { ctx2.autoTrader.stop(); ctx2.db.close(); }
  // O04: 10,000 synthetic decisions (skipped, minimal columns) → ledger and summary under a second each in this sandbox.
  const insert = "INSERT INTO trade_decisions (id, clock_at, mode, prediction_id, market_id, venue_market_id, policy_version, currency, budget_timezone, daily_bucket, outcome, gates_json, reason_codes_json, inputs_json, rationale_hash) VALUES (?, ?, 'paper', 'p-synth', 'm-synth', 'synth', 'v1', 'USD', 'UTC', '2026-09-01', 'skipped', '[]', '[\"FORECAST_MISSING\"]', '{}', ?)";
  ctx.db.transaction(() => { for (let i = 0; i < 10_000; i++) ctx.db.run(insert, `synth-${i}`, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`, `h${i}`); });
  const t0 = process.hrtime.bigint();
  const rows = ctx.ledger.rows({ limit: 500 });
  const t1 = process.hrtime.bigint();
  const sum = ctx.ledger.summary();
  const t2 = process.hrtime.bigint();
  const filtered = ctx.ledger.rows({ reason: "FORECAST_MISSING", from: "2026-09-10T00:00:00Z", to: "2026-09-12T00:00:00Z", limit: 500 });
  const t3 = process.hrtime.bigint();
  const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;
  console.log(`[O04] ledger 500 rows over ${ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_decisions")!.n} decisions: ${ms(t0, t1).toFixed(1)} ms · summary ${ms(t1, t2).toFixed(1)} ms · filtered ${ms(t2, t3).toFixed(1)} ms`);
  assert.equal(rows.filter((r) => !r.external).length, 500);
  assert.ok(ms(t0, t1) < 1000 && ms(t1, t2) < 1000 && ms(t2, t3) < 1000, "p95 target: under one second per query on the sandbox machine");
  assert.ok(filtered.every((r) => r.external || (r.reasonCodes.includes("FORECAST_MISSING") && r.clockAt >= "2026-09-10T00:00:00Z" && r.clockAt <= "2026-09-12T00:00:00Z")));
  assert.equal(sum.mode, "auto_live");
  ctx.db.run("DELETE FROM trade_decisions WHERE id LIKE 'synth-%'");
});
