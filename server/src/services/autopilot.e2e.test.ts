/**
 * Prediction Ledger — U02 end to end with fakes only: a saved channel → a video imported through a FAKE yt-dlp (captions)
 * → extraction by a FAKE model → the scheduler matches the pick on the FAKE US venue, verifies the contract, builds a
 * qualified forecast and places one bounded automatic order on the FAKE trading venue (1.14, AUTO-02).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Skipped on Windows (the fake yt-dlp is a POSIX shell wrapper) and when ffmpeg is not installed (the importer probes
 * it). The production qualification and the paper rehearsal are inserted by SQL as labelled test shortcuts, exactly as
 * in automation.test.ts. No network; no real key; no real money.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AUTO_LIVE_ACKNOWLEDGEMENT, type ModelInfo, type ProviderTestResult } from "@prediction-ledger/shared";
import type { CompletionRequest, CompletionResult, LanguageModelProvider, ProviderCredentials } from "../providers/llm/types.js";
import { setLlmProviderForTests } from "../providers/llm/registry.js";
import type { MarketProvider, MarketSummary, OrderBookSnapshot, PricePoint } from "../providers/markets/types.js";
import { setMarketProviderForTests } from "../providers/markets/registry.js";
import { FakeTradingAdapter, fakeBalance } from "../providers/trading/fake.js";
import { setTradingAdapterForTests } from "../providers/trading/registry.js";
import { locateTools } from "../media/ffmpeg.js";
import type { VideoLister } from "./subscriptions.js";

const tools = await locateTools().catch(() => undefined);
const skip = process.platform === "win32" ? "fake yt-dlp wrapper needs a POSIX shell" : tools ? false : "ffmpeg not installed";

const T = "2026-10-01T12:00:00Z";
const KEY = "11111111-2222-3333-4444-555555555555";
const SECRET = crypto.randomBytes(32).toString("base64");
const RULES = "If Detroit wins, the market will resolve to Lions. If Buffalo wins, the market will resolve to Bills. If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, this market will resolve 50-50.";
const LIONS = { name: "Detroit Lions", abbreviation: "DET", league: "nfl", alias: "Lions" };
const BILLS = { name: "Buffalo Bills", abbreviation: "BUF", league: "nfl", alias: "Bills" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const usMoneyline = (id: string, start: string): MarketSummary => ({
  provider: "polymarket_us", id, slug: `aec-nfl-det-buf-${id}`, url: `https://polymarket.us/event/nfl-det-buf-${id}`, question: `Detroit vs. Buffalo (${id})`, description: RULES,
  event: { id: `ev-${id}`, slug: `nfl-det-buf-${id}`, title: "DET Lions vs BUF Bills" },
  outcomes: [{ label: "Lions", tokenId: `aec-nfl-det-buf-${id}:YES`, price: 0.5 }, { label: "Bills", tokenId: `aec-nfl-det-buf-${id}:NO`, price: 0.5 }], endDate: start, active: true, closed: false, retrievedAt: "2026-09-16T00:00:00Z",
  constraints: { venue: "polymarket_us", slug: `aec-nfl-det-buf-${id}`, status: "MARKET_STATUS_OPEN", tickSize: "0.01", minQuantity: "1", feeCoefficient: "0.06", sides: [{ id: `${id}-l`, label: "Lions", long: true, team: LIONS }, { id: `${id}-b`, label: "Bills", long: false, team: BILLS }], category: "sports", sportsMarketType: "SPORTS_MARKET_TYPE_MONEYLINE", gameStartTime: start, eventStartTime: start, retrievedAt: "2026-09-16T00:00:00Z" },
});

/** The canned extraction reply: one moneyline pick on the Lions for the fixture game (synthetic, not a real model output). */
const extractionReply = JSON.stringify({ predictions: [{
  quote: "I like the Lions tonight, give me Detroit on the moneyline", speaker: "Host", normalized_statement: "Detroit Lions beat Buffalo Bills on 2026-10-01 (moneyline).", modality: "will", entities: ["Detroit Lions", "Buffalo Bills"], topic: "NFL picks", geography: null, scope: null, conditions: [], thresholds: [],
  time_expression: "tonight", proposed_deadline: "2026-10-01", ambiguities: [], confidence: 0.9, components: [{ kind: "future_claim", statement: "Detroit Lions beat Buffalo Bills on 2026-10-01 (moneyline).", deadline: "2026-10-01", notes: null }],
  sports_pick: { sport: "NFL", league: "nfl", teams: ["Detroit Lions", "Buffalo Bills"], event_date: "2026-10-01", pick_type: "moneyline", team: "Lions", line: null, side: null },
}] });

class FakeModel implements LanguageModelProvider {
  readonly id = "lmstudio" as const;
  readonly displayName = "fake";
  readonly isLocal = true;
  requests: CompletionRequest[] = [];
  async testConnection(): Promise<ProviderTestResult> { return { ok: true, provider: this.id, message: "fake" }; }
  async listModels(): Promise<ModelInfo[]> { return []; }
  async complete(_c: ProviderCredentials, req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    return { text: req.jsonSchema?.name === "extraction_output" ? extractionReply : "{}", model: req.model };
  }
}

class FakeUs implements MarketProvider {
  readonly id = "polymarket_us" as const;
  byId = new Map<string, MarketSummary>();
  async search(): Promise<MarketSummary[]> { return [...this.byId.values()].filter((m) => !m.resolved); }
  async get(idOrSlug: string): Promise<MarketSummary | undefined> { return this.byId.get(idOrSlug) ?? [...this.byId.values()].find((m) => m.slug === idOrSlug); }
  async list(): Promise<MarketSummary[]> { return []; }
  async book(tokenId: string): Promise<OrderBookSnapshot> { return { provider: "polymarket_us", tokenId, bids: [{ price: 0.49, size: 500 }], asks: [{ price: 0.5, size: 500 }], retrievedAt: T }; }
  async priceHistory(): Promise<PricePoint[]> { return []; }
  async eventMarkets(): Promise<MarketSummary[]> { return []; }
}

const FAKE_YTDLP = String.raw`
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const url = args[args.length - 1];
const id = /v=([A-Za-z0-9_-]{11})/.exec(url)?.[1];
const out = args.includes("-o") ? args[args.indexOf("-o") + 1] : null;
if (args.includes("--version")) { console.log("2026.09.01"); process.exit(0); }
if (args.includes("--dump-single-json")) {
  console.log(JSON.stringify({ id, title: "Lions picks " + id, channel: "Creator A", channel_id: "UC-A", duration: 20, upload_date: "20260930", language: "en", subtitles: { en: [{ ext: "vtt" }] } }));
  process.exit(0);
}
if (args.includes("--write-subs")) {
  const lang = args[args.indexOf("--sub-langs") + 1];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(out), id + "." + lang + ".vtt"), "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nI like the Lions tonight, give me Detroit on the moneyline.\n\n2\n00:00:04.000 --> 00:00:06.000\nBuffalo is banged up and Detroit is at home.\n");
  process.exit(0);
}
process.stderr.write("fake yt-dlp: unrecognised invocation\n"); process.exit(1);
`;

test("U02 (end to end) — channel poll → fake yt-dlp captions → fake-model extraction → scheduler: match on the fake venue → verified contract → qualified forecast → one bounded automatic order with the full audit graph", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-autopilot-"));
  const fakeJs = path.join(dir, "fake-ytdlp.mjs");
  const wrapper = path.join(dir, "yt-dlp");
  fs.writeFileSync(fakeJs, FAKE_YTDLP);
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  process.env.PL_YTDLP_PATH = wrapper;
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-autopilot-ctx-"));
  const model = new FakeModel();
  const fakeUs = new FakeUs();
  const fake = new FakeTradingAdapter();
  let clock = T;
  fake.now = () => new Date(Date.parse(clock));
  setLlmProviderForTests("lmstudio", model);
  setMarketProviderForTests("polymarket_us", fakeUs);
  setTradingAdapterForTests(fake);
  const listings: Record<string, { title?: string; entries: { id: string; title?: string; uploadDate?: string; channel?: string }[] }> = {};
  const lister: VideoLister = async (url) => listings[url] ?? { entries: [] };
  const { createContext } = await import("../context.js");
  const ctx = createContext({ now: () => new Date(Date.parse(clock)), lister, leaseHolder: "e2e" });
  try {
    const s = ctx.settings.getPersisted();
    s.providers.lmstudio.enabled = true;
    s.providers.lmstudio.model = "fake";
    s.stages = { extraction: { provider: "lmstudio" }, validationPlan: { provider: "lmstudio" }, assessment: { provider: "lmstudio" } };
    s.privacy.allowInternet = true;
    s.markets.venues = ["polymarket", "polymarket_us"];
    s.sports.enabled = true;
    ctx.settings.savePersisted(s);

    // Creator A's history on the fake venue (four settled Lions picks at .25, three wins) so a forecast carries edge.
    const claim = (marketId: string, day: string) => {
      const video = ctx.videos.createFromYouTube({ youtubeId: `h${day.slice(5).replace("-", "")}xxxxxx`, url: `https://www.youtube.com/watch?v=h${day.slice(5).replace("-", "")}xxxxxx`, title: "history", publishedAt: day, channel: "Creator A", channelId: "UC-A", firstSeenAt: `${day}T00:00:00.000Z` });
      ctx.videos.applyYouTubeInfo(video.id, { publishedPrecision: "date" });
      const m = ctx.markets.get(marketId)!;
      const p = ctx.predictions.create({ videoId: video.id, kind: "sports_pick", sportsPick: { sport: "NFL", league: "nfl", teams: ["Detroit Lions", "Buffalo Bills"], eventDate: m.constraints!.gameStartTime!.slice(0, 10), pick: { type: "moneyline", team: "Detroit Lions" } }, quoteExact: `Lions ${day}`, normalizedStatement: "Detroit Lions win", entities: [], conditions: [], thresholds: [], madeOnDate: day, madeOnBasis: "publication", deadlineDate: m.constraints!.gameStartTime!.slice(0, 10), deadlineBasis: "rule:absolute", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: "Detroit Lions win" }] });
      const link = ctx.markets.propose({ predictionId: p.id, marketId: m.id, side: "Lions", score: 1, relation: "exact", matchedBy: "rule:sports", status: "accepted" });
      ctx.db.run("UPDATE predictions SET created_at = ? WHERE id = ?", `${day}T00:00:00.000Z`, p.id);
      ctx.db.run("UPDATE prediction_market_links SET created_at = ?, updated_at = ? WHERE id = ?", `${day}T00:00:00.000Z`, `${day}T00:00:00.000Z`, link.id);
      const v = ctx.contracts.verifyLink(link.id);
      ctx.db.run("UPDATE contract_verifications SET created_at = ? WHERE id = ?", `${day}T00:00:00.000Z`, v.id);
    };
    const games: [string, string, string, "Lions" | "Bills"][] = [["g01", "2026-09-01", "2026-08-31T23:00:00Z", "Lions"], ["g02", "2026-09-02", "2026-09-01T23:00:00Z", "Lions"], ["g03", "2026-09-03", "2026-09-02T23:00:00Z", "Lions"], ["g04", "2026-09-04", "2026-09-03T23:00:00Z", "Bills"]];
    for (const [id, day, priceAt, winner] of games) {
      const summary = usMoneyline(id, `${day}T17:00:00Z`);
      fakeUs.byId.set(id, summary);
      const m = ctx.markets.upsertFromSummary(summary, { snapshot: false });
      const snap = ctx.markets.addSnapshot(m.id, { ...summary, outcomes: [{ label: "Lions", tokenId: `${summary.slug}:YES`, price: 0.25 }, { label: "Bills", tokenId: `${summary.slug}:NO`, price: 0.75 }] }, "history");
      ctx.db.run("UPDATE market_snapshots SET retrieved_at = ? WHERE id = ?", priceAt, snap.id);
      claim(m.id, day);
      const resolved: MarketSummary = { ...summary, resolved: true, resolvedOutcome: winner, closed: true, active: false, constraints: { ...summary.constraints!, status: "MARKET_STATUS_RESOLVED" } };
      fakeUs.byId.set(id, resolved);
      ctx.markets.upsertFromSummary(resolved, { snapshot: false });
      ctx.db.run("UPDATE markets SET resolved_at = ? WHERE id = ?", `${day}T21:00:00Z`, m.id);
    }
    // Tonight's contract exists on the venue but nothing in the app points at it yet.
    fakeUs.byId.set("tonight", usMoneyline("tonight", "2026-10-01T18:00:00Z"));

    // Account, limits, qualification (TEST SHORTCUT by SQL), paper rehearsal (TEST SHORTCUT by SQL), arming.
    fake.script(KEY, { secretKey: SECRET, balances: [fakeBalance("1000.00", "1000.00")] });
    const bindingId = (await ctx.trading.connect({ keyId: KEY, secretKey: SECRET })).binding.id;
    ctx.trading.setLimits({ maxOpenMarkets: 50, totalOpenRisk: "1000", dailyCommitmentCap: "1000", perEvent: "100" }, { budgetTimezone: "UTC" });
    ctx.trading.setAutomation({ minReevaluateMs: 0 });
    ctx.db.run("INSERT INTO strategy_qualifications (id, strategy_version, category, source, events, brier, baseline_brier, qualified, report_json, created_at) VALUES (?, ?, 'sports', 'production', 120, '0.20', '0.22', 1, ?, ?)", crypto.randomUUID(), ctx.forecasts.strategyVersion, JSON.stringify({ note: "TEST SHORTCUT — inserted by autopilot.e2e.test.ts; not strategy evidence" }), clock);
    for (let i = 0; i < 20; i++) ctx.db.run("INSERT INTO paper_us_positions (id, intent_id, decision_id, market_id, venue_market_id, side, quantity, avg_cost, cost_total, fees, status, opened_at, settled_at, outcome, pnl, method) VALUES (?, ?, ?, 'rehearsal', ?, 'yes', '1', '0.5', '0.5', '0', 'settled', ?, ?, 'win', '0.5', 'us-ioc-v1')", crypto.randomUUID(), `ti-${i}`, `td-${i}`, `r-${i}`, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z");
    assert.ok(ctx.lease.acquire(60_000));
    await ctx.trading.sync();
    await ctx.execution.startStream();
    ctx.trading.arm({ acknowledge: AUTO_LIVE_ACKNOWLEDGEMENT, policyHash: ctx.trading.policy().policyHash, category: "sports", strategyVersion: ctx.forecasts.strategyVersion });
    assert.deepEqual(ctx.autoTrader.liveEnabled(), { ok: true, reasons: [] });

    // 1. The saved channel is polled: one new video → video.import (fake yt-dlp captions) → prediction.extract (fake model).
    const sub = ctx.subscriptions.create({ url: "https://www.youtube.com/@creator-a/videos", autoExtract: true, lookbackDays: 0 });
    listings[sub.url] = { title: "Creator A", entries: [{ id: "tonightpick", title: "Lions picks tonight", uploadDate: "2026-09-30", channel: "Creator A" }] };
    ctx.jobs.start();
    const poll = ctx.jobs.enqueue({ kind: "subscription.poll", payload: { subscriptionId: sub.id } });
    const waitJob = async (id: string, ms = 30_000) => { const t0 = Date.now(); for (;;) { const j = ctx.jobs.get(id)!; if (["completed", "failed", "cancelled"].includes(j.status)) return j; if (Date.now() - t0 > ms) throw new Error(`job ${id} timed out (${j.status})`); await sleep(100); } };
    assert.equal((await waitJob(poll)).status, "completed");
    const video = ctx.videos.findByYouTubeId("tonightpick")!;
    assert.ok(video && video.subscriptionId === sub.id);
    for (let i = 0; i < 300 && !ctx.predictions.list({ videoId: video.id }).length; i++) await sleep(100);
    const picks = ctx.predictions.list({ videoId: video.id });
    assert.equal(picks.length, 1, `extraction produced one pick: ${JSON.stringify(ctx.videos.get(video.id))}`);
    assert.equal(picks[0].kind, "sports_pick");
    assert.equal(ctx.videos.get(video.id)!.transcriptSource, "captions-manual");
    assert.equal(model.requests.length, 1, "one extraction call; the model never sees anything else");

    // 2. Scheduler: tick 1 queues market.match (job); the match finds tonight's contract and auto-accepts the exact matchup.
    const before = fake.createCalls;
    const r1 = await ctx.autoTrader.tick();
    assert.equal(r1.outcome, "completed");
    assert.equal(ctx.autoTrader.candidatesFor(r1.id).filter((c) => c.reason === "market_match_queued").length, 1);
    for (let i = 0; i < 300 && !ctx.markets.linksForPrediction(picks[0].id).length; i++) await sleep(100);
    const link = ctx.markets.linksForPrediction(picks[0].id)[0];
    assert.ok(link && link.status === "accepted", JSON.stringify(link));
    // 3. Tick 2: verification → qualified forecast → eligible auto-live decision → one automatic order.
    const r2 = await ctx.autoTrader.tick();
    const ordered = ctx.autoTrader.candidatesFor(r2.id).find((c) => c.outcome === "ordered");
    assert.ok(ordered, JSON.stringify({ r2, cands: ctx.autoTrader.candidatesFor(r2.id) }));
    assert.equal(fake.createCalls, before + 1, "exactly one venue create call");
    const intent = ctx.execution.intent(ordered!.intentId!)!;
    const decision = ctx.decisions.get(ordered!.decisionId!)!;
    assert.equal(intent.state, "filled");
    assert.equal(decision.mode, "auto_live");
    assert.equal(ctx.forecasts.get(decision.forecastId!)!.status, "qualified");
    assert.equal(fake.calls.filter((c) => c.method === "createOrder").at(-1)!.args?.manual, false, "automatic indicator");
    // Complete audit graph from the source to the fill.
    const verification = ctx.markets.getVerification(decision.verificationId!)!;
    assert.equal(verification.linkId, link.id);
    assert.equal(verification.status, "verified_equivalent");
    assert.equal(ctx.predictions.get(decision.predictionId)!.videoId, video.id);
    assert.equal(ctx.execution.getPreview(intent.previewId!)!.decisionHash, decision.rationaleHash);
    assert.ok(intent.order && intent.executions!.some((e) => e.type === "fill" || e.type === "partial_fill"));
    const kinds = ctx.trading.auditEvents(300).map((e) => e.kind);
    for (const k of ["policy.mode_changed", "automation.tick", "order.previewed", "order.submitting", "order.acknowledged"]) assert.ok(kinds.includes(k), k);
    assert.ok(!JSON.stringify(ctx.trading.auditEvents(300)).includes(SECRET));
    // 4. Nothing more on that contract, ever (a second tick, a second poll): the opportunity is consumed.
    const r3 = await ctx.autoTrader.tick();
    assert.equal(r3.ordered, 0);
    assert.equal(r3.skipped.opportunity_consumed, 1);
    assert.equal(fake.createCalls, before + 1);
    assert.ok(ctx.risk.opportunityConsumed(bindingId, "polymarket_us", "tonight"));
  } finally {
    ctx.autoTrader.stop();
    await ctx.jobs.stop();
    ctx.execution.stopStream();
    ctx.db.close();
    delete process.env.PL_DATA_DIR;
    delete process.env.PL_YTDLP_PATH;
    setMarketProviderForTests("polymarket_us", undefined);
    setTradingAdapterForTests(undefined);
  }
});
