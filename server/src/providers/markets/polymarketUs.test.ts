/**
 * Prediction Ledger — Polymarket US market-data adapter tests (1.10). Fixtures captured from the public gateway on 2026-09-16.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { normalizeUsMarket, PolymarketUsProvider, usTokenId } from "./polymarketUs.js";
import { MarketApiError } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "..", "..", "fixtures", "trading");
const load = (...p: string[]) => JSON.parse(fs.readFileSync(path.join(fixtures, ...p), "utf8")) as Record<string, unknown>;

function stubFetch(routes: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ code: 5, message: "not found" }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("normalizeUsMarket: YES side is the `long` market side regardless of the deprecated outcomes order; NO is the complement; constraints captured verbatim", () => {
  // outcomes = ["No","Yes"] on this market — orientation must come from marketSides[].long, never the array.
  const btc = normalizeUsMarket(load("markets", "us-market-btc-100k.json").market as Record<string, unknown>, undefined, "2026-09-16T15:00:00Z");
  assert.equal(btc.provider, "polymarket_us");
  assert.equal(btc.id, "268833");
  assert.equal(btc.slug, "cpc-btc-100k-10-31-2026");
  assert.equal(btc.outcomes[0].label, "Yes");
  assert.equal(btc.outcomes[0].tokenId, usTokenId(btc.slug, "YES"));
  assert.deepEqual({ bid: btc.outcomes[0].bestBid, ask: btc.outcomes[0].bestAsk, price: btc.outcomes[0].price }, { bid: 0.06, ask: 0.07, price: 0.065 });
  assert.deepEqual({ label: btc.outcomes[1].label, bid: btc.outcomes[1].bestBid, ask: btc.outcomes[1].bestAsk, price: btc.outcomes[1].price }, { label: "No", bid: 0.93, ask: 0.94, price: 0.935 });
  assert.equal(btc.question, "When will Bitcoin cross $100k again? — Before November 2026");
  assert.match(btc.description ?? "", /settle to Yes if the price of Bitcoin/);
  assert.equal(btc.active, true);
  assert.equal(btc.closed, false);
  assert.ok(btc.tags?.includes("crypto") && btc.tags.includes("currency:usd"));
  const c = btc.constraints!;
  assert.equal(c.venue, "polymarket_us");
  assert.deepEqual({ tick: c.tickSize, minQty: c.minQuantity, fee: c.feeCoefficient, status: c.status, cat: c.category, type: c.sportsMarketType }, { tick: "0.01", minQty: "0.01", fee: "0.06", status: "MARKET_STATUS_OPEN", cat: "crypto", type: "SPORTS_MARKET_TYPE_FUTURE" });
  assert.equal(c.line, undefined);
  assert.equal(c.eventStartTime, undefined, "no event was supplied, so nothing is invented");
  assert.deepEqual(c.sides.map((s) => [s.id, s.label, s.long]), [["537230", "Yes", true], ["537231", "No", false]]);
  assert.equal(btc.url, "https://gateway.polymarket.us/v1/market/slug/cpc-btc-100k-10-31-2026", "no event slug known → the data URL, not an invented page");

  // A resolved NFL moneyline: outcomes = ["Chargers","Titans"], Chargers is the long side; status RESOLVED → closed + resolved.
  const nfl = normalizeUsMarket(load("markets", "us-market-nfl-lac-ten.json").market as Record<string, unknown>, { id: "9", slug: "nfl-lac-ten-2025-11-02", title: "LAC vs TEN", startTime: "2025-11-02T18:00:00Z" }, "2026-09-16T15:00:00Z");
  assert.deepEqual(nfl.outcomes.map((o) => o.label), ["Chargers", "Titans"]);
  assert.equal(nfl.closed, true);
  assert.equal(nfl.resolved, true);
  assert.equal(nfl.url, "https://polymarket.us/event/nfl-lac-ten-2025-11-02");
  assert.deepEqual({ tick: nfl.constraints!.tickSize, minQty: nfl.constraints!.minQuantity, game: nfl.constraints!.gameStartTime, ev: nfl.constraints!.eventStartTime, type: nfl.constraints!.sportsMarketType }, { tick: "0.001", minQty: "1", game: "2025-11-02T18:00:00Z", ev: "2025-11-02T18:00:00Z", type: "SPORTS_MARKET_TYPE_MONEYLINE" });
});

test("PolymarketUsProvider: search flattens events, get by slug/id, list falls back from league to categories, NO book mirrors YES, history uses fidelity=1 and the requested side", async () => {
  const calls: string[] = [];
  const search = load("markets", "us-search-bitcoin.json");
  const market = load("markets", "us-market-btc-100k.json");
  const book = load("books", "us-book-btc-100k.json");
  const history = { history: [{ timestamp: 1789000000, longPrice: 0.11, shortPrice: 0.9 }, { timestamp: 1788999000, longPrice: 0.1, shortPrice: 0.91 }] };
  const provider = new PolymarketUsProvider({
    fetchImpl: stubFetch({
      "/v1/search?": search,
      "/v1/market/slug/cpc-btc-100k-10-31-2026": market,
      "/v1/market/id/268833": market,
      "/v2/leagues/nfl/events": { events: [] },
      "/v1/markets?": { markets: [market.market] },
      "/v1/markets/cpc-btc-100k-10-31-2026/book": book,
      "/v1/price-history?": history,
    }, calls),
  });

  const found = await provider.search("bitcoin", { limit: 5 });
  assert.equal(found.length, 4, "2 events × 2 markets");
  assert.ok(found.every((m) => m.provider === "polymarket_us" && m.event?.slug));
  assert.equal(found[0].event?.slug, "btc-above-yr-12-31-2026");
  assert.equal(found[0].url, "https://polymarket.us/event/btc-above-yr-12-31-2026");
  assert.match(calls[0], /status=active/);

  const bySlug = await provider.get("cpc-btc-100k-10-31-2026");
  assert.equal(bySlug?.id, "268833");
  const byToken = await provider.get(usTokenId("cpc-btc-100k-10-31-2026", "NO"));
  assert.equal(byToken?.id, "268833", "a synthetic token id resolves to its market");
  const byId = await provider.get("268833");
  assert.equal(byId?.slug, "cpc-btc-100k-10-31-2026");
  assert.equal(await provider.get("does-not-exist"), undefined);

  const listed = await provider.list({ tag: "nfl", limit: 5 });
  assert.equal(listed.length, 1, "empty league answer → category listing");
  assert.match(calls.find((u) => u.includes("/v1/markets?")) ?? "", /categories=nfl/);

  const yes = await provider.book(usTokenId("cpc-btc-100k-10-31-2026", "YES"));
  assert.deepEqual(yes.bids[0], { price: 0.06, size: 61 });
  assert.deepEqual(yes.asks[0], { price: 0.07, size: 4433.03 });
  assert.equal(yes.midpoint, 0.065);
  const no = await provider.book(usTokenId("cpc-btc-100k-10-31-2026", "NO"));
  assert.deepEqual(no.bids[0], { price: 0.93, size: 4433.03 }, "a YES ask at 0.07 is a NO bid at 0.93");
  assert.deepEqual(no.asks[0], { price: 0.94, size: 61 });
  assert.equal(no.midpoint, 0.935);

  const hYes = await provider.priceHistory(usTokenId("cpc-btc-100k-10-31-2026", "YES"), { from: "2026-09-10T00:00:00Z", to: "2026-09-16T00:00:00Z" });
  assert.deepEqual(hYes.map((p) => p.p), [0.1, 0.11], "ascending by time");
  const hNo = await provider.priceHistory(usTokenId("cpc-btc-100k-10-31-2026", "NO"), { from: "2026-09-10T00:00:00Z", to: "2026-09-16T00:00:00Z" });
  assert.deepEqual(hNo.map((p) => p.p), [0.91, 0.9]);
  const hCall = calls.find((u) => u.includes("/v1/price-history?"))!;
  assert.match(hCall, /fidelity=1/);
  assert.match(hCall, /symbol=cpc-btc-100k-10-31-2026/);
  assert.match(hCall, /timestamp\.startTimestamp=\d+&timestamp\.endTimestamp=\d+/);

  // A venue error surfaces as a typed MarketApiError with the venue's status, never as data.
  const failing = new PolymarketUsProvider({ fetchImpl: (async () => new Response("upstream down", { status: 503 })) as typeof fetch });
  await assert.rejects(() => failing.search("x"), (e: unknown) => e instanceof MarketApiError && e.status === 503 && e.provider === "polymarket_us");
});
