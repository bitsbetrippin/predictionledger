/**
 * Prediction Ledger — O07 harness rehearsal (2.0): the scheduler runs in PAPER autopilot over a compressed seven-day
 * clock against fake market data, with a data outage, a rate-limited book, a sleep past a cutoff and a crash/restart
 * injected; the soak report then judges the run and the qualification report says "pending" for the small cohort.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * THIS IS A HARNESS REHEARSAL, NOT THE SOAK: the real O07 soak runs the app for seven calendar days on real venue data
 * in paper autopilot (SETUP §4.16) and its report is attached by the owner. A synthetic cohort never qualifies anything.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { MarketProvider, MarketSummary, OrderBookSnapshot, PricePoint } from "../providers/markets/types.js";
import { setMarketProviderForTests } from "../providers/markets/registry.js";
import type { AppContext } from "../context.js";
import { D } from "../analysis/decimal.js";

const RULES = "If Detroit wins, the market will resolve to Lions. If Buffalo wins, the market will resolve to Bills. If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, this market will resolve 50-50.";
const LIONS = { name: "Detroit Lions", abbreviation: "DET", league: "nfl", alias: "Lions" };
const BILLS = { name: "Buffalo Bills", abbreviation: "BUF", league: "nfl", alias: "Bills" };

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
  /** Injected market-data faults: the book call throws (outage / 429). */
  outage?: string;
  bookCalls = 0;
  async search(): Promise<MarketSummary[]> { return []; }
  async get(idOrSlug: string): Promise<MarketSummary | undefined> { return this.byId.get(idOrSlug); }
  async list(): Promise<MarketSummary[]> { return []; }
  async book(tokenId: string): Promise<OrderBookSnapshot> {
    this.bookCalls++;
    if (this.outage) throw new Error(this.outage);
    return { provider: "polymarket_us", tokenId, bids: [{ price: 0.49, size: 500 }], asks: [{ price: 0.5, size: 500 }], retrievedAt: clock };
  }
  async priceHistory(): Promise<PricePoint[]> { return []; }
  async eventMarkets(): Promise<MarketSummary[]> { return []; }
}

let ctx: AppContext;
let dataDir: string;
const fakeUs = new FakeUs();
let clock = "2026-10-01T09:00:00Z";
let seq = 0;
const A = { channelId: "UC-A", name: "Creator A" };
const B = { channelId: "UC-B", name: "Creator B" };
const C = { channelId: "UC-C", name: "Creator C" };
const now = () => new Date(Date.parse(clock));

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-soak-"));
  process.env.PL_DATA_DIR = dataDir;
  setMarketProviderForTests("polymarket_us", fakeUs);
  const { createContext } = await import("../context.js");
  ctx = createContext({ now, leaseHolder: "soak-1" });
  const s = ctx.settings.getPersisted();
  s.privacy.allowInternet = true;
  s.markets.venues = ["polymarket", "polymarket_us"];
  ctx.settings.savePersisted(s);
  // Creator A: a usable history (four settled Lions picks at .25, three wins) — the same fixture as 1.12–1.14. Creator B: none.
  const games: [string, string, string, "Lions" | "Bills"][] = [["g01", "2026-09-01", "2026-08-31T23:00:00Z", "Lions"], ["g02", "2026-09-02", "2026-09-01T23:00:00Z", "Lions"], ["g03", "2026-09-03", "2026-09-02T23:00:00Z", "Lions"], ["g04", "2026-09-04", "2026-09-03T23:00:00Z", "Bills"]];
  for (const [id, day, priceAt, winner] of games) { const m = market(id, `${day}T17:00:00Z`, { yesPrice: 0.25, priceAt }); claim(A, m.id, "Detroit Lions", day); resolve(id, winner, `${day}T21:00:00Z`); }
  ctx.paperUs.setBankrollStart("500");
  ctx.trading.setAutomation({ minReevaluateMs: 0, intervalMs: 5_000, paperAutopilot: true, maxEvaluationsPerTick: 10, maxPerSourcePerTick: 10 });
  assert.equal(ctx.trading.policy().mode, "paper");
});
after(async () => { ctx?.autoTrader.stop(); await ctx?.jobs.stop(); ctx?.db.close(); delete process.env.PL_DATA_DIR; setMarketProviderForTests("polymarket_us", undefined); });

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
  const id = `s${String(seq).padStart(4, "0")}${creator.channelId.slice(0, 3)}`;
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

const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;

test("O07 (harness) — seven compressed days of paper autopilot with an outage, a rate-limited book, a sleep past a cutoff and a restart: no duplicate entry, no cap breach, every intent explained; the report says so — and flags an injected duplicate", async () => {
  const { createContext } = await import("../context.js");
  const faults: string[] = [];
  const dayMarkets: string[][] = [];
  for (let d = 1; d <= 7; d++) {
    // Morning: four new picks per day (two by Creator A with history, one each by Creators B and C without), games at 23:00.
    clock = `${day(d)}T09:00:00Z`;
    const ids = [`d${d}a`, `d${d}b`, `d${d}c`, `d${d}d`];
    dayMarkets.push(ids);
    for (const [i, id] of ids.entries()) { const m = market(id, `${day(d)}T23:00:00Z`); claim(i === 2 ? B : i === 3 ? C : A, m.id, "Detroit Lions", `${day(d)}T08:30:00Z`); }
    if (d === 5) {
      // Crash / restart between two ticks: a new process on the same directory picks up the paper autopilot setting.
      ctx.autoTrader.stop(); await ctx.jobs.stop(); ctx.db.close();
      ctx = createContext({ now, leaseHolder: `soak-${d}` });
      faults.push("restart on day 5");
    }
    const hours = d === 4 ? ["10:00"] : ["10:00", "12:00", "14:00", "16:00", "18:00", "20:00"]; // day 4: the machine sleeps after 10:00 (its games resolve only the next evening)
    for (const h of hours) {
      clock = `${day(d)}T${h}:00Z`;
      if (d === 3 && (h === "12:00" || h === "14:00")) { fakeUs.outage = "market data outage (503)"; faults.push(`outage ${day(d)} ${h}`); }
      else if (d === 6 && h === "16:00") { fakeUs.outage = "rate limited (429)"; faults.push(`429 ${day(d)} ${h}`); }
      else fakeUs.outage = undefined;
      const run = await ctx.autoTrader.tick();
      assert.notEqual(run.outcome, "failed", JSON.stringify(run));
    }
    fakeUs.outage = undefined;
    // Night: the games resolve and the paper positions settle (Lions win on odd days, Bills on even days). Day 4's games
    // stay unresolved until day 5 evening, so day 5's ticks see them with a cutoff that passed while the machine slept.
    clock = `${day(d)}T23:30:00Z`;
    const settleIds = d === 4 ? [] : d === 5 ? [...dayMarkets[3], ...ids] : ids;
    for (const id of settleIds) { const dd = Number(id.slice(1, 2)); resolve(id, dd % 2 ? "Lions" : "Bills", clock); ctx.decisions.settleResolved(ctx.markets.list().find((m) => m.venueId === id)!.id, clock); }
    if (d === 4) faults.push("sleep from day 4 10:00 to day 5 09:00 (day-4 cutoffs passed unattended)");
  }
  clock = "2026-10-08T09:00:00Z";
  const r = ctx.reports.soak({ from: "2026-10-01T00:00:00Z", to: clock });
  const md = ctx.reports.soakMarkdown(r, "Paper-soak report — SYNTHETIC HARNESS REHEARSAL (compressed clock, fake market data; not the owner's 7-day soak)");
  fs.writeFileSync(path.join(dataDir, "soak-report.md"), md);
  fs.writeFileSync(path.join(dataDir, "soak-report.json"), JSON.stringify({ faultsInjected: faults, ...r }, null, 2));
  // The thresholds of O07 hold on this run.
  assert.equal(r.window.daysWithActivity, 7, JSON.stringify(r.window));
  assert.ok(r.decisions.total >= 100, `decisions ${r.decisions.total}`);
  assert.ok(r.events.distinctEvents >= 10, `events ${r.events.distinctEvents}`);
  assert.deepEqual(r.duplicates.accountMarketPairsWithMultipleEntries, []);
  assert.equal(r.capChecks.orderBudgetBreaches, 0);
  assert.deepEqual(r.capChecks.dailyCapBreaches, []);
  assert.deepEqual(r.intents.unexplained, []);
  assert.equal(r.intents.unknownOpen, 0);
  assert.equal(r.verdict, "complete", r.shortfalls.join("; "));
  assert.equal(r.ticks.failed, 0);
  // The faults left their marks: missing-data gates during the outage / 429, cutoff_passed after the sleep, a restart's lease holder.
  assert.ok(r.decisions.missingData > 0, "outage ticks produced BOOK_MISSING decisions (abstention measured, not hidden)");
  assert.ok((r.evaluations.reasons["skipped:cutoff_passed"] ?? 0) >= 4, JSON.stringify(r.evaluations.reasons));
  assert.equal(r.faults.leaseHolders, 2, "two processes over the week (the restart)");
  assert.ok(r.paper.settled >= 4 && r.paper.positions === r.paper.settled, `paper ${JSON.stringify(r.paper)}`);
  assert.ok(D(r.paper.fees).gt("0"));
  // Exactly one entry per contract, ever; Creators B and C never trade (no usable history → insufficient data); Creator A's
  // edge decays as its own picks settle against it (Bills win on even days), so later picks abstain on edge — recorded, not hidden.
  const entries = ctx.db.all<{ venue_market_id: string; n: number }>("SELECT venue_market_id, COUNT(*) AS n FROM trade_intents WHERE mode = 'paper' GROUP BY venue_market_id");
  assert.ok(entries.every((e) => e.n === 1), JSON.stringify(entries));
  assert.ok(entries.length >= 4 && entries.length <= 12, `${entries.length} entries`);
  assert.ok((r.decisions.reasonCodes.FORECAST_INSUFFICIENT ?? 0) > 0, "Creators B and C's picks abstain with a recorded reason");
  assert.ok((r.decisions.reasonCodes.EDGE_NEGATIVE ?? 0) + (r.decisions.reasonCodes.EDGE_BELOW_MIN ?? 0) + (r.decisions.reasonCodes.PROB_NOT_ABOVE_HALF ?? 0) > 0, "edge/probability gates abstain with recorded reasons");
  // An injected duplicate entry is caught by the report (the check is real, not decorative).
  const first = ctx.db.get<{ id: string; venue_market_id: string; decision_id: string; reservation_id: string; account_key: string }>("SELECT id, venue_market_id, decision_id, reservation_id, account_key FROM trade_intents WHERE mode = 'paper' LIMIT 1")!;
  ctx.db.run("INSERT INTO trade_intents (id, decision_id, reservation_id, mode, account_key, provider, venue_market_id, side, quantity, wire_price, limit_cost, time_in_force, state, payload_hash, created_at, updated_at) VALUES ('dup-injected', ?, ?, 'paper', ?, 'polymarket_us', ?, 'yes', '1', '0.5', '0.5', 'IOC', 'filled', 'x', ?, ?)", first.decision_id, first.reservation_id, first.account_key, first.venue_market_id, "2026-10-07T12:00:00Z", "2026-10-07T12:00:00Z");
  const r2 = ctx.reports.soak({ from: "2026-10-01T00:00:00Z", to: clock });
  assert.equal(r2.thresholds.zeroDuplicates, false);
  assert.equal(r2.verdict, "incomplete");
  assert.ok(r2.shortfalls.some((s) => /more than one entry/.test(s)));
  ctx.db.run("DELETE FROM trade_intents WHERE id = 'dup-injected'");
  // Route rendering (markdown and JSON) is exercised by the report CLI; here the markdown carries the verdict and the label.
  assert.match(md, /SYNTHETIC HARNESS REHEARSAL/);
  assert.match(md, /Verdict: \*\*complete\*\*/);
});

test("O07 (harness) — the qualification report on the same synthetic cohort is PENDING (28 distinct settled events of 100), never qualified, and writes no production record", () => {
  const q = ctx.reports.qualification({ category: "sports", asOf: clock });
  const md = ctx.reports.qualificationMarkdown(q, "Qualification report — SYNTHETIC HARNESS REHEARSAL (fake cohort; never strategy evidence)");
  fs.writeFileSync(path.join(dataDir, "qualification-report.md"), md);
  assert.equal(q.status, "pending", q.statement);
  assert.ok(q.cohort.settledEvents < 100 && q.cohort.settledEvents >= 20, `settled ${q.cohort.settledEvents}`);
  assert.ok(q.evaluation.events >= 90 && q.evaluation.events > q.cohort.settledEvents * 3, `${q.evaluation.events} settled DECISIONS, yet the cohort is ${q.cohort.settledEvents} events — the gate counts events`);
  assert.equal(q.eventsNeeded, 100 - q.cohort.settledEvents);
  assert.equal(q.evaluation.gate.qualified, false);
  assert.equal(q.productionRecord, undefined, "nothing was written to strategy_qualifications");
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM strategy_qualifications")!.n, 0);
  assert.ok(q.creators.some((c) => c.key.includes("UC-A") || c.observations >= 4), JSON.stringify(q.creators));
  assert.match(q.statement, /PENDING/);
  assert.match(md, /Status: \*\*pending\*\*/);
  assert.ok(!ctx.forecasts.qualifiedCategories().includes("sports"));
});
