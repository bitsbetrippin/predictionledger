/**
 * Prediction Ledger — the pinned `polymarket-us` SDK's real request behaviour, with `fetch` stubbed (1.13, E03/E05).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Unlike polymarketUs.test.ts (a fake SDK module), this file loads the pinned SDK itself and replaces the global
 * `fetch` it uses, so what is asserted is the exact HTTP request the real SDK builds from the adapter's call: URL,
 * method, JSON body (price passed through verbatim, YES-denominated), auth headers present and the raw secret
 * absent. No network is used. The test skips itself when the package is not installed (sandbox builds).
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { POLYMARKET_US_HOSTS, POLYMARKET_US_SDK, PolymarketUsTradingAdapter } from "./polymarketUs.js";
import { TradingAdapterError } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "..", "..", "fixtures", "trading", "orders");
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(fixtures, f), "utf8")) as unknown;

interface Captured { url: string; method: string; headers: Record<string, string>; body?: string }
type Answer = { status: number; json?: unknown } | { throws: Error } | { hang: true };

/** Install a fetch stub for the duration of `fn`; every request is captured and answered from the queue. */
async function withFetch(answers: Answer[], fn: (captured: Captured[]) => Promise<void>): Promise<Captured[]> {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const a = answers.shift();
    if (!a) throw new Error("unexpected request");
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    captured.push({ url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : undefined });
    if ("throws" in a) throw a.throws;
    if ("hang" in a) return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
    return new Response(a.json === undefined ? "" : JSON.stringify(a.json), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await fn(captured); } finally { globalThis.fetch = original; }
  return captured;
}

const SECRET = crypto.randomBytes(32).toString("base64");
const creds = { keyId: "11111111-2222-3333-4444-555555555555", secretKey: SECRET };

test("pinned SDK — the real polymarket-us client posts the adapter's order body verbatim to the production API with signed headers and never leaks the secret; failures classify as documented", async (t) => {
  let installed = true;
  try { await import("polymarket-us"); } catch { installed = false; }
  if (!installed) { t.skip(`${POLYMARKET_US_SDK.package}@${POLYMARKET_US_SDK.version} is not installed here (run npm install in the project folder); the fake-SDK tests still cover the adapter`); return; }
  const adapter = new PolymarketUsTradingAdapter({ minIntervalMs: 0, timeoutMs: 200 });
  const orderFixture = (load("order-partial-canceled.json") as { order: unknown }).order;

  // 1. Preview of a NO order: POST /v1/order/preview with { request: <create body> }; price is the YES-denominated .60.
  const preview = await withFetch([{ status: 200, json: { order: orderFixture } }], async () => {
    const p = await adapter.previewOrder(creds, { marketSlug: "aec-nfl-det-buf-2026-10-01", side: "no", action: "buy", yesPrice: "0.6", quantity: "23", timeInForce: "IOC", manual: true });
    assert.equal(p.order?.side, "no");
    assert.equal(p.order?.yesPrice, "0.60");
  });
  assert.equal(preview.length, 1);
  assert.equal(preview[0].url, `${POLYMARKET_US_HOSTS.api}/v1/order/preview`);
  assert.equal(preview[0].method, "POST");
  assert.deepEqual(JSON.parse(preview[0].body!), { request: { marketSlug: "aec-nfl-det-buf-2026-10-01", intent: "ORDER_INTENT_BUY_SHORT", type: "ORDER_TYPE_LIMIT", price: { value: "0.6", currency: "USD" }, quantity: 23, tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL", manualOrderIndicator: "MANUAL_ORDER_INDICATOR_MANUAL" } });
  assert.equal(preview[0].headers["X-PM-Access-Key"], creds.keyId);
  assert.ok(preview[0].headers["X-PM-Signature"] && preview[0].headers["X-PM-Timestamp"], "Ed25519 signature headers are set by the SDK");
  assert.ok(!JSON.stringify(preview[0]).includes(SECRET), "the raw secret is never on the wire");

  // 2. Create of a YES order: POST /v1/orders, body verbatim, id = acceptance; no executions on the asynchronous default.
  const create = await withFetch([{ status: 200, json: load("create-response.json") }], async () => {
    const r = await adapter.createOrder(creds, { marketSlug: "aec-nfl-det-buf-2026-10-01", side: "yes", action: "buy", yesPrice: "0.5", quantity: "19", timeInForce: "IOC", manual: true });
    assert.equal(r.orderId, "ord-synthetic-create-1");
    assert.deepEqual(r.executions, []);
  });
  assert.equal(create[0].url, `${POLYMARKET_US_HOSTS.api}/v1/orders`);
  assert.deepEqual(JSON.parse(create[0].body!), { marketSlug: "aec-nfl-det-buf-2026-10-01", intent: "ORDER_INTENT_BUY_LONG", type: "ORDER_TYPE_LIMIT", price: { value: "0.5", currency: "USD" }, quantity: 19, tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL", manualOrderIndicator: "MANUAL_ORDER_INDICATOR_MANUAL" });
  assert.ok(!Object.keys(JSON.parse(create[0].body!) as object).some((k) => /client|idempot|nonce/i.test(k)), "the API has no client order id / idempotency field: none is invented");

  // 3. Failure classes through the real SDK's error path.
  const req = { marketSlug: "m", side: "yes" as const, action: "buy" as const, yesPrice: "0.5", quantity: "1", timeInForce: "IOC" as const, manual: true };
  const classify = async (answer: Answer) => {
    let cls: string | undefined;
    await withFetch([answer], async () => {
      try { await adapter.createOrder(creds, req); cls = "created"; } catch (err) { assert.ok(err instanceof TradingAdapterError); cls = `${adapter.classifySubmitFailure(err)}:${err.code}`; }
    });
    return cls;
  };
  assert.equal(await classify({ status: 200, json: {} }), "ambiguous:unknown", "a 2xx without an id is not proof of anything");
  assert.equal(await classify({ throws: new TypeError("fetch failed") }), "ambiguous:network");
  assert.equal(await classify({ hang: true }), "ambiguous:timeout", "the SDK's own timeout → APIError(408) → ambiguous");
  assert.equal(await classify({ status: 500, json: { message: "internal" } }), "ambiguous:venue_unavailable");
  assert.equal(await classify({ status: 503, json: { message: "maintenance" } }), "ambiguous:venue_unavailable");
  assert.equal(await classify({ status: 400, json: { message: "ORD_REJECT_REASON_INVALID_PRICE_INCREMENT" } }), "not_created:bad_request");
  assert.equal(await classify({ status: 401, json: { message: "invalid signature" } }), "not_created:unauthorized");
  assert.equal(await classify({ status: 403, json: { message: "trading restricted" } }), "not_created:forbidden");
  assert.equal(await classify({ status: 429, json: { message: "rate limited" } }), "ambiguous:rate_limited", "2.0 (RV-12): a 429 does not prove nothing was created — held for the owner, never resent");

  // 4. Reads used by reconciliation: GET /v1/order/{id} and GET /v1/portfolio/activities normalise to decimal strings.
  const reads = await withFetch([{ status: 200, json: load("order-partial-canceled.json") }, { status: 200, json: load("activities.json") }], async () => {
    const o = await adapter.getOrder(creds, "ord-synthetic-no-1");
    assert.deepEqual({ state: o?.state, filled: o?.filledQuantity, side: o?.side, yes: o?.yesPrice, avg: o?.avgPrice, fees: o?.feesCollected, qty: o?.quantity }, { state: "canceled", filled: "10", side: "no", yes: "0.60", avg: "0.60", fees: "0.20", qty: "19" });
    const a = await adapter.activities(creds, {});
    assert.equal(a.eof, true);
    assert.equal(a.activities.length, 3);
    const trade = a.activities.find((x) => x.kind === "trade")!;
    assert.deepEqual({ tradeId: trade.tradeId, q: trade.quantity, p: trade.yesPrice, slug: trade.marketSlug }, { tradeId: "trd-synthetic-1", q: "4", p: "0.50", slug: "aec-nfl-det-buf-2026-10-01" });
    assert.equal((trade.raw as Record<string, unknown>).orderId, undefined, "documented shape: a trade activity carries no order id");
    const res = a.activities.find((x) => x.kind === "position_resolution")!;
    assert.deepEqual({ side: res.resolutionSide, before: res.positionBefore, after: res.positionAfter }, { side: "POSITION_RESOLUTION_SIDE_LONG", before: "4", after: "0" });
  });
  assert.equal(reads[0].url, `${POLYMARKET_US_HOSTS.api}/v1/order/ord-synthetic-no-1`);
  assert.ok(reads[1].url.startsWith(`${POLYMARKET_US_HOSTS.api}/v1/portfolio/activities?`));
  for (const c of [...preview, ...create, ...reads]) {
    assert.ok(c.url.startsWith(POLYMARKET_US_HOSTS.api), "every call goes to the fixed production API host");
    assert.equal(c.headers["X-PM-Access-Key"], creds.keyId);
  }
});
