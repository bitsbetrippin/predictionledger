/**
 * Prediction Ledger — Manifold adapter tests (stubbed fetch; shapes copied from live responses, 2026-09-16).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ManifoldProvider, normalizeManifoldMarket } from "./manifold.js";

const live = { id: "lZSUlny28S", slug: "will-rsa2048-encryption-be-broken-b", question: "Will RSA-2048 encryption be broken before Bitcoin reaches $150K USD?", probability: 0.11322, totalLiquidity: 100, volume: 265.39, volume24Hours: 0, closeTime: 1797051540000, isResolved: false, outcomeType: "BINARY", url: "https://manifold.markets/strutheo/will-rsa2048-encryption-be-broken-b", token: "MANA", textDescription: "Resolves YES if…", creatorUsername: "strutheo" };

test("normalizeManifoldMarket: binary → Yes/No with synthetic token ids, close time → endDate, token tag", () => {
  const m = normalizeManifoldMarket(live as never, "2026-09-16T00:00:00Z");
  assert.equal(m.provider, "manifold");
  assert.deepEqual(m.outcomes, [{ label: "Yes", tokenId: "lZSUlny28S:YES", price: 0.1132 }, { label: "No", tokenId: "lZSUlny28S:NO", price: 0.8868 }]);
  assert.equal(m.endDate, new Date(1797051540000).toISOString());
  assert.equal(m.active, true);
  assert.deepEqual(m.tags, ["token:mana"]);
  assert.equal(m.description, "Resolves YES if…");
  const done = normalizeManifoldMarket({ ...live, isResolved: true, resolution: "YES" } as never);
  assert.equal(done.closed, true);
  assert.equal(done.resolvedOutcome, "Yes");
});

function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}

test("ManifoldProvider: search (binary only), get by id/slug, book midpoint, price history from bets (NO side inverted)", async () => {
  const mf = new ManifoldProvider({
    fetchImpl: stubFetch({
      "/search-markets?": [live, { ...live, id: "multi", outcomeType: "MULTIPLE_CHOICE" }],
      "/market/lZSUlny28S": live,
      "/slug/will-rsa": live,
      "/bets?contractId=lZSUlny28S": [{ createdTime: 1788465141140, probAfter: 0.113 }, { createdTime: 1786954321440, probAfter: 0.1125 }],
    }),
  });
  const found = await mf.search("rsa");
  assert.equal(found.length, 1, "non-binary markets dropped");
  assert.equal((await mf.get("lZSUlny28S"))?.question, live.question);
  assert.equal((await mf.get("will-rsa2048-encryption-be-broken-b"))?.id, "lZSUlny28S");
  assert.equal(await mf.get("zzzzzzzzzz"), undefined);
  assert.equal((await mf.book("lZSUlny28S:NO")).midpoint, 0.8868);
  const hist = await mf.priceHistory("lZSUlny28S:NO", { from: "2026-08-01T00:00:00Z", to: "2026-09-16T00:00:00Z" });
  assert.deepEqual(hist.map((h) => h.p), [0.8875, 0.887], "ascending, inverted for NO");
});
