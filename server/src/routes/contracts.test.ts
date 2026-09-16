/**
 * Prediction Ledger — contract routes tests (1.11): M02, M03, M08 (via revalidate), M09 and pasted-URL discovery, through Fastify inject with a fake US venue.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
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
import { registerCsrfGuard } from "../security/csrf.js";
import { registerMarketRoutes } from "./markets.js";
import type { AppContext } from "../context.js";

const csrf = { [CSRF_HEADER]: CSRF_VALUE, origin: "http://127.0.0.1:7317" };
const RULES = "If Detroit wins, the market will resolve to Lions. If Buffalo wins, the market will resolve to Bills. If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, this market will resolve 50-50.";
const LIONS = { name: "Detroit Lions", abbreviation: "DET", league: "nfl", alias: "Lions" };
const BILLS = { name: "Buffalo Bills", abbreviation: "BUF", league: "nfl", alias: "Bills" };

function usMoneyline(id: string, over: Partial<MarketSummary> & { status?: string; start?: string } = {}): MarketSummary {
  const start = over.start ?? "2026-10-01T13:00:00Z";
  const { status, start: _s, ...rest } = over;
  return {
    provider: "polymarket_us", id, slug: `aec-nfl-det-buf-${id}`, url: "https://polymarket.us/event/nfl-det-buf-2026-10-01", question: "Detroit vs. Buffalo", description: RULES,
    event: { id: "ev-a", slug: "nfl-det-buf-2026-10-01", title: "DET Lions vs BUF Bills" },
    outcomes: [{ label: "Lions", tokenId: `x${id}:YES`, price: 0.45 }, { label: "Bills", tokenId: `x${id}:NO`, price: 0.55 }], endDate: start, active: status ? /OPEN/.test(status) : true, closed: status ? !/OPEN/.test(status) : false, retrievedAt: "2026-09-16T00:00:00Z",
    constraints: { venue: "polymarket_us", slug: `aec-nfl-det-buf-${id}`, status: status ?? "MARKET_STATUS_OPEN", tickSize: "0.01", minQuantity: "1", feeCoefficient: "0.06", sides: [{ id: `${id}-l`, label: "Lions", long: true, team: LIONS }, { id: `${id}-b`, label: "Bills", long: false, team: BILLS }], category: "sports", sportsMarketType: "SPORTS_MARKET_TYPE_MONEYLINE", gameStartTime: start, eventStartTime: start, retrievedAt: "2026-09-16T00:00:00Z" },
    ...rest,
  };
}

class FakeUs implements MarketProvider {
  readonly id = "polymarket_us" as const;
  searchResults: MarketSummary[] = [];
  eventResults: MarketSummary[] = [];
  byId = new Map<string, MarketSummary>();
  async search(): Promise<MarketSummary[]> { return this.searchResults; }
  async get(idOrSlug: string): Promise<MarketSummary | undefined> { return this.byId.get(idOrSlug); }
  async list(): Promise<MarketSummary[]> { return []; }
  async book(tokenId: string): Promise<OrderBookSnapshot> { return { provider: "polymarket_us", tokenId, bids: [], asks: [], retrievedAt: "" }; }
  async priceHistory(): Promise<PricePoint[]> { return []; }
  async eventMarkets(): Promise<MarketSummary[]> { return this.eventResults; }
}

let ctx: AppContext;
let app: ReturnType<typeof Fastify>;
const fakeUs = new FakeUs();

before(async () => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-contracts-"));
  setMarketProviderForTests("polymarket_us", fakeUs);
  const { createContext } = await import("../context.js");
  ctx = createContext();
  const s = ctx.settings.getPersisted();
  s.privacy.allowInternet = true;
  s.markets.venues = ["polymarket", "polymarket_us"];
  ctx.settings.savePersisted(s);
  app = Fastify();
  registerCsrfGuard(app, () => ["http://127.0.0.1:7317"]);
  registerMarketRoutes(app, ctx);
});
after(() => { ctx?.db.close(); delete process.env.PL_DATA_DIR; setMarketProviderForTests("polymarket_us", undefined); });

function pick(quote: string, team: string, eventDate = "2026-10-01") {
  const { video } = ctx.videos.importTranscript({ title: "Picks", content: `1\n00:00:00,000 --> 00:00:05,000\n${quote}\n`, format: "srt", publishedAt: "2026-09-28" });
  return ctx.predictions.create({ videoId: video.id, kind: "sports_pick", sportsPick: { sport: "NFL", league: "nfl", teams: ["Detroit Lions", "Buffalo Bills"], eventDate, pick: { type: "moneyline", team } }, quoteExact: quote, normalizedStatement: `${team} win`, entities: ["Detroit Lions", "Buffalo Bills"], conditions: [], thresholds: [], madeOnDate: "2026-09-28", madeOnBasis: "publication", deadlineDate: eventDate, deadlineBasis: "rule:absolute", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: `${team} win` }] });
}

test("M02 — no market, two plausible markets, or only an international market give explicit none / multiple / research-only answers; nothing becomes a trade candidate", async () => {
  const p = pick("Bills win outright", "Buffalo Bills");
  fakeUs.searchResults = [];
  const none = await app.inject({ method: "POST", url: `/api/predictions/${p.id}/us-candidates`, headers: csrf, payload: {} });
  assert.equal(none.statusCode, 200, none.body);
  assert.equal(none.json().outcome, "none");
  assert.equal(none.json().candidates.length, 0);
  // Two equally plausible moneylines (a doubleheader listing error, say): multiple, both proposed, none accepted.
  fakeUs.searchResults = [usMoneyline("100"), usMoneyline("101")];
  const multi = await app.inject({ method: "POST", url: `/api/predictions/${p.id}/us-candidates`, headers: csrf, payload: {} });
  assert.equal(multi.json().outcome, "multiple");
  assert.equal(multi.json().candidates.length, 2);
  assert.ok(multi.json().notes.some((n: string) => /ambiguity never becomes a trade candidate/.test(n)));
  for (const c of multi.json().candidates) assert.equal(ctx.markets.getLink(c.linkId)!.status, "proposed");
  assert.equal(ctx.markets.executableLinks(p.id).length, 0);
  // Only an international market linked: research-only, and the US search finds nothing.
  const p2 = pick("Lions cover", "Detroit Lions");
  const intl = ctx.markets.upsertFromSummary({ provider: "polymarket", id: "intl-1", slug: "lions-bills", url: "https://polymarket.com/event/x", question: "Lions vs Bills", outcomes: [{ label: "Lions", tokenId: "a" }, { label: "Bills", tokenId: "b" }], active: true, closed: false, retrievedAt: "" });
  const legacy = ctx.markets.propose({ predictionId: p2.id, marketId: intl.id, side: "Lions", score: 1, relation: "exact", matchedBy: "rule:sports", status: "accepted" });
  fakeUs.searchResults = [];
  const ro = await app.inject({ method: "POST", url: `/api/predictions/${p2.id}/us-candidates`, headers: csrf, payload: {} });
  assert.equal(ro.json().outcome, "none");
  assert.deepEqual(ro.json().researchOnly.map((r: { linkId: string; provider: string }) => [r.linkId, r.provider]), [[legacy.id, "polymarket"]]);
  // M03: the legacy accepted link is still accepted for research but execution-unverified; verifying it answers research_only.
  assert.equal(ctx.markets.getLink(legacy.id)!.status, "accepted");
  assert.equal(ctx.markets.getLink(legacy.id)!.verificationStatus, "unverified");
  const v = await app.inject({ method: "POST", url: `/api/market-links/${legacy.id}/verify-contract`, headers: csrf, payload: {} });
  assert.equal(v.statusCode, 201, v.body);
  assert.equal(v.json().status, "research_only");
  assert.equal(ctx.markets.getLink(legacy.id)!.status, "accepted");
  assert.equal(ctx.markets.executableLinks(p2.id).length, 0);
});

test("pasted event URL → the event's contracts; a single exact match is `one`, verifies, and revalidation marks it stale when the venue halts it (M08); overrides are refused (M09)", async () => {
  const p = pick("Bills win this week", "Buffalo Bills");
  const m = usMoneyline("200");
  fakeUs.eventResults = [m];
  fakeUs.byId.set("200", m);
  const one = await app.inject({ method: "POST", url: `/api/predictions/${p.id}/us-candidates`, headers: csrf, payload: { url: "https://polymarket.us/event/nfl-det-buf-2026-10-01" } });
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(one.json().outcome, "one");
  const linkId: string = one.json().candidates[0].linkId;
  assert.equal(ctx.markets.getLink(linkId)!.matchedBy, "user");
  ctx.markets.setLinkStatus(linkId, "accepted");
  // Verify: complete checklist → verified_equivalent; the link becomes the one executable candidate.
  const v1 = await app.inject({ method: "POST", url: `/api/market-links/${linkId}/verify-contract`, headers: csrf, payload: {} });
  assert.equal(v1.statusCode, 201, v1.body);
  assert.equal(v1.json().status, "verified_equivalent", JSON.stringify(v1.json().fields.filter((f: { status: string }) => f.status !== "verified")));
  assert.equal(v1.json().sideId, "200-b");
  assert.equal(ctx.markets.executableLinks(p.id).length, 1);
  const list = await app.inject({ method: "GET", url: `/api/market-links/${linkId}/verifications` });
  assert.equal(list.json().verifications.length, 1);
  assert.equal(list.json().link.verificationStatus, "verified_equivalent");
  // Direct status writes are refused; facts on hard gates are ignored; malformed facts are rejected.
  const forced = await app.inject({ method: "PUT", url: `/api/market-links/${linkId}/verification-status`, headers: csrf, payload: { status: "verified_equivalent" } });
  assert.equal(forced.statusCode, 405);
  const bad = await app.inject({ method: "POST", url: `/api/market-links/${linkId}/verify-contract`, headers: csrf, payload: { facts: { league: { value: "nfl" } } } });
  assert.equal(bad.statusCode, 400);
  // The venue halts the market: revalidate marks the verification stale; a fresh verification is incompatible.
  fakeUs.byId.set("200", usMoneyline("200", { status: "MARKET_STATUS_HALTED" }));
  const re = await app.inject({ method: "POST", url: `/api/market-links/${linkId}/revalidate`, headers: csrf });
  assert.equal(re.statusCode, 200, re.body);
  assert.equal(re.json().refreshed, true);
  assert.match(re.json().reasons.join(";"), /not open/);
  assert.equal(re.json().verification.status, "stale");
  assert.equal(ctx.markets.executableLinks(p.id).length, 0, "a stale verification is not executable");
  const v2 = await app.inject({ method: "POST", url: `/api/market-links/${linkId}/verify-contract`, headers: csrf, payload: { facts: { market_open: { value: "open", source: "screenshot" } } } });
  assert.equal(v2.json().status, "incompatible");
  assert.equal(v2.json().version, 2);
  assert.match(v2.json().fields.find((f: { id: string }) => f.id === "market_open").note, /accepts no override/);
  // M09 with missing fields: a US contract with no start time cannot be forced executable by facts on hard gates.
  const p3 = pick("Lions win", "Detroit Lions");
  const noStart = usMoneyline("300", { start: undefined as never });
  noStart.constraints!.gameStartTime = undefined; noStart.constraints!.eventStartTime = undefined; noStart.endDate = undefined;
  fakeUs.eventResults = [noStart];
  const c3 = await app.inject({ method: "POST", url: `/api/predictions/${p3.id}/us-candidates`, headers: csrf, payload: { url: "https://polymarket.us/event/nfl-det-buf-2026-10-01" } });
  const link3: string = c3.json().candidates[0].linkId;
  const v3 = await app.inject({ method: "POST", url: `/api/market-links/${link3}/verify-contract`, headers: csrf, payload: { facts: { side: { value: "300-l", source: "me" }, rules_hash: { value: "x", source: "me" } } } });
  assert.equal(v3.json().status, "incomplete");
  assert.ok(v3.json().fields.some((f: { id: string; status: string }) => f.id === "game_start" && f.status === "missing"));
  assert.equal(v3.json().cutoffUnknown, true);
  assert.equal(ctx.markets.executableLinks(p3.id).length, 0);
});
