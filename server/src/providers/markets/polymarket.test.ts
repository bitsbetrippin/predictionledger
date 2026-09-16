/**
 * Prediction Ledger — Polymarket adapter tests (stubbed fetch; shapes copied from live responses, 2026-09-15).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeGammaMarket, PolymarketProvider } from "./polymarket.js";
import { MarketApiError } from "./types.js";

const gammaMarket = {
  id: "559651", question: "Xi Jinping out before 2027?", conditionId: "0xa467", slug: "xi-jinping-out-before-2027", description: "Resolves Yes if…",
  outcomes: '["Yes", "No"]', outcomePrices: '["0.0405", "0.9595"]', clobTokenIds: '["3233", "2565"]', liquidity: "221349.40316", volume: "13254473.35", volume24hr: 19079.3,
  bestBid: 0.039, bestAsk: 0.042, lastTradePrice: 0.039, endDate: "2027-01-01T04:59:00Z", active: true, closed: false, restricted: false,
  events: [{ id: "30828", slug: "xi-jinping-out-before-2027", title: "Xi Jinping out before 2027?" }],
};

test("normalizeGammaMarket: JSON-string fields become typed outcomes; complement bid/ask derived", () => {
  const m = normalizeGammaMarket(gammaMarket as never, "2026-09-15T00:00:00Z");
  assert.equal(m.provider, "polymarket");
  assert.equal(m.outcomes.length, 2);
  assert.deepEqual(m.outcomes[0], { label: "Yes", tokenId: "3233", price: 0.0405, bestBid: 0.039, bestAsk: 0.042 });
  assert.deepEqual(m.outcomes[1], { label: "No", tokenId: "2565", price: 0.9595, bestBid: 0.958, bestAsk: 0.961 });
  assert.equal(m.liquidity, 221349.40316);
  assert.equal(m.url, "https://polymarket.com/event/xi-jinping-out-before-2027");
  assert.equal(m.retrievedAt, "2026-09-15T00:00:00Z");
});

function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("PolymarketProvider: search flattens events → markets, get by id/slug, list by tag, book + midpoint, errors typed", async () => {
  const pm = new PolymarketProvider({
    fetchImpl: stubFetch({
      "/public-search?": { events: [{ id: "1", slug: "btc-100k", title: "When will Bitcoin hit $100k?", markets: [{ ...gammaMarket, events: undefined }, { ...gammaMarket, id: "2", closed: true, events: undefined }] }] },
      "/markets/559651": gammaMarket,
      "/markets?slug=": [gammaMarket],
      "/events?tag_slug=nfl": [{ id: "9", slug: "lions-vs-bills", title: "Lions vs. Bills", markets: [{ ...gammaMarket, id: "77", question: "Lions vs. Bills", outcomes: '["Lions","Bills"]', outcomePrices: '["0.45","0.55"]', events: undefined }] }],
      "/book?token_id=3233": { bids: [{ price: "0.039", size: "100" }, { price: "0.04", size: "50" }], asks: [{ price: "0.042", size: "80" }] },
      "/midpoint?token_id=3233": { mid: "0.0405" },
      "/prices-history?market=3233": { history: [{ t: 1757404814, p: "0.155" }, { t: 1757401213, p: 0.15 }] },
    }),
  });
  const found = await pm.search("bitcoin 100k");
  assert.equal(found.length, 1, "closed market filtered out");
  assert.equal(found[0].event?.title, "When will Bitcoin hit $100k?");
  assert.equal((await pm.get("559651"))?.question, "Xi Jinping out before 2027?");
  assert.equal((await pm.get("xi-jinping-out-before-2027"))?.id, "559651");
  const nfl = await pm.list({ tag: "nfl" });
  assert.equal(nfl[0].outcomes.map((o) => o.label).join("/"), "Lions/Bills");
  assert.equal(nfl[0].event?.slug, "lions-vs-bills");
  const book = await pm.book("3233");
  assert.equal(book.bids[0].price, 0.04, "bids sorted best first");
  assert.equal(book.midpoint, 0.0405);
  assert.equal(await pm.get("999999"), undefined, "404 → undefined");
  const hist = await pm.priceHistory("3233", { from: "2025-09-09T00:00:00Z", to: "2025-09-10T00:00:00Z" });
  assert.deepEqual(hist.map((h) => h.p), [0.15, 0.155], "sorted ascending by time, strings coerced");
  assert.equal(hist[0].t, "2025-09-09T07:00:13.000Z");
  assert.deepEqual(await pm.priceHistory("3233", { from: "2025-09-10T00:00:00Z", to: "2025-09-09T00:00:00Z" }), [], "empty range → no call");
  const broken = new PolymarketProvider({ fetchImpl: (async () => new Response("rate limited", { status: 429 })) as typeof fetch });
  await assert.rejects(() => broken.list({}), (e: unknown) => e instanceof MarketApiError && e.status === 429);
});
