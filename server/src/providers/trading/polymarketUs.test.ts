/**
 * Prediction Ledger — Polymarket US trading adapter tests (1.10) against a fake SDK module. No network, no real key.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mapError, normalizeBalances, normalizeOpenOrders, normalizePositionsPage, numberToDecimal, POLYMARKET_US_HOSTS, PolymarketUsTradingAdapter, type SdkModuleLike } from "./polymarketUs.js";
import { TradingAdapterError } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "..", "..", "fixtures", "trading", "account");
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(fixtures, f), "utf8")) as unknown;

const SECRET = crypto.randomBytes(32).toString("base64");
const creds = { keyId: "11111111-2222-3333-4444-555555555555", secretKey: SECRET };

interface Recorded { method: string; path: string; authenticated?: boolean; query?: Record<string, unknown>; body?: unknown; ctor: Record<string, unknown> }

/** A fake `polymarket-us` module: records constructor options and every request; answers from a route table. */
function fakeSdk(routes: Record<string, unknown | (() => never)>, log: Recorded[]): SdkModuleLike {
  return {
    PolymarketUS: class {
      constructor(private readonly opts: Record<string, unknown> = {}) {}
      private answer(method: string, p: string, o: { query?: Record<string, unknown>; body?: unknown; authenticated?: boolean } = {}) {
        log.push({ method, path: p, authenticated: o.authenticated, query: o.query, body: o.body, ctor: this.opts });
        const key = Object.keys(routes).find((k) => p.startsWith(k));
        if (!key) throw Object.assign(new Error("Not Found"), { status: 404 });
        const r = routes[key];
        if (typeof r === "function") (r as () => never)();
        return Promise.resolve(r);
      }
      get<T>(p: string, o?: { query?: Record<string, unknown>; authenticated?: boolean }) { return this.answer("GET", p, o) as Promise<T>; }
      post<T>(p: string, o?: { body?: unknown; authenticated?: boolean }) { return this.answer("POST", p, o) as Promise<T>; }
    } as unknown as SdkModuleLike["PolymarketUS"],
  };
}

test("adapter reads go through the SDK as authenticated requests on the fixed production hosts; fixtures normalise to decimal strings; there is no order-creation method", async () => {
  const log: Recorded[] = [];
  const sdk = fakeSdk({ "/v1/account/balances": load("balances.json"), "/v1/portfolio/positions": load("positions.json"), "/v1/orders/open": load("open-orders.json"), "/v1/order/ord-synthetic-1/cancel": {} }, log);
  const adapter = new PolymarketUsTradingAdapter({ loadSdk: async () => sdk, minIntervalMs: 0 });
  assert.deepEqual(adapter.hosts, POLYMARKET_US_HOSTS);

  const balances = await adapter.balances(creds);
  assert.equal(balances.length, 1);
  assert.deepEqual(balances[0].buyingPower, { value: "95.25", currency: "USD" });
  assert.deepEqual(balances[0].currentBalance, { value: "100.5", currency: "USD" });
  assert.deepEqual(balances[0].openOrdersNotional, { value: "5.25", currency: "USD" });
  assert.equal(balances[0].precisionSource, "number", "the venue returns JSON numbers for balances");

  const page = await adapter.positions(creds);
  assert.equal(page.eof, true);
  assert.equal(page.positions[0].netQuantity, "10.5", "decimal-string field wins over the deprecated rounded integer");
  assert.deepEqual(page.positions[0].cost, { value: "0.70", currency: "USD" });
  assert.equal(page.positions[0].eventSlug, "btc-100k");

  const orders = await adapter.openOrders(creds, { marketSlugs: ["cpc-btc-100k-10-31-2026"] });
  assert.deepEqual(orders[0], { id: "ord-synthetic-1", marketSlug: "cpc-btc-100k-10-31-2026", intent: "ORDER_INTENT_BUY_LONG", state: "ORDER_STATE_NEW", price: { value: "0.05", currency: "USD" }, quantity: "10", filledQuantity: "0", createTime: "2026-09-16T11:30:00Z" });

  const cancel = await adapter.cancelOrder(creds, "ord-synthetic-1", "cpc-btc-100k-10-31-2026");
  assert.deepEqual(cancel, { orderId: "ord-synthetic-1", outcome: "requested" });

  // Every call was authenticated, addressed to the production API host, and carried the credentials only to the SDK constructor.
  assert.deepEqual(log.map((l) => [l.method, l.path, l.authenticated]), [["GET", "/v1/account/balances", true], ["GET", "/v1/portfolio/positions", true], ["GET", "/v1/orders/open", true], ["POST", "/v1/order/ord-synthetic-1/cancel", true]]);
  assert.ok(log.every((l) => l.ctor.apiBaseUrl === POLYMARKET_US_HOSTS.api && l.ctor.gatewayBaseUrl === POLYMARKET_US_HOSTS.gateway && l.ctor.keyId === creds.keyId && l.ctor.secretKey === SECRET));
  assert.deepEqual(log[2].query, { slugs: ["cpc-btc-100k-10-31-2026"] });
  assert.deepEqual(log[3].body, { marketSlug: "cpc-btc-100k-10-31-2026" });
  assert.ok(!log.some((l) => l.method === "POST" && /\/v1\/orders$|preview|batched|modify|close-position/.test(l.path)));
  for (const name of ["createOrder", "create", "preview", "previewOrder", "submit", "modify", "closePosition", "cancelAll"]) {
    assert.equal((adapter as unknown as Record<string, unknown>)[name], undefined, `no ${name} method exists in 1.10`);
  }
});

test("host allowlist: a base-URL override is refused unless explicitly marked test-only; a missing SDK is reported, not crashed", async () => {
  assert.throws(() => new PolymarketUsTradingAdapter({ apiBaseUrl: "http://127.0.0.1:9/" }), (e: unknown) => e instanceof TradingAdapterError && e.code === "host_not_allowed");
  assert.throws(() => new PolymarketUsTradingAdapter({ gatewayBaseUrl: "https://evil.example" }), (e: unknown) => e instanceof TradingAdapterError && e.code === "host_not_allowed");
  const test = new PolymarketUsTradingAdapter({ apiBaseUrl: "http://127.0.0.1:9/", allowTestHosts: true, loadSdk: async () => fakeSdk({ "/v1/account/balances": { balances: [] } }, []) });
  assert.equal(test.hosts.api, "http://127.0.0.1:9/");
  const missing = new PolymarketUsTradingAdapter({ loadSdk: async () => { throw new Error("Cannot find package 'polymarket-us'"); } });
  await assert.rejects(() => missing.balances(creds), (e: unknown) => e instanceof TradingAdapterError && e.code === "sdk_missing" && /Cannot find package/.test(e.message));
});

test("errors map to stable codes and never carry key material, even when the venue echoes it back", async () => {
  const echo = (status: number, message: string) => () => { throw Object.assign(new Error(message), { status }); };
  const log: Recorded[] = [];
  const mk = (status: number, message: string) => new PolymarketUsTradingAdapter({ minIntervalMs: 0, loadSdk: async () => fakeSdk({ "/v1/account/balances": echo(status, message) }, log) });
  const expect = async (status: number, message: string, code: string) => {
    await assert.rejects(() => mk(status, message).balances(creds), (e: unknown) => {
      assert.ok(e instanceof TradingAdapterError, String(e));
      assert.equal(e.code, code, `${status} ${message}`);
      assert.ok(!e.message.includes(SECRET) && !e.message.includes(creds.keyId), e.message);
      return true;
    });
  };
  await expect(401, "Unauthorized", "unauthorized");
  await expect(401, "request timestamp expired (skew > 30s)", "clock_skew");
  await expect(403, "account not permitted to trade", "forbidden");
  await expect(429, "Too Many Requests", "rate_limited");
  await expect(503, "Service Unavailable", "venue_unavailable");
  await expect(0, "fetch failed: ECONNRESET", "network");
  await expect(408, "Request timeout", "timeout");
  await expect(401, `bad signature for X-PM-Access-Key ${creds.keyId} secret ${SECRET}`, "unauthorized");
  const e = mapError(new Error(`X-PM-Signature: abcdefghijklmnopqrstuvwxyz0123456789== key ${SECRET}`), [SECRET]);
  assert.ok(!e.message.includes(SECRET));
  assert.ok(!e.message.includes("abcdefghijklmnopqrstuvwxyz0123456789"), e.message);
});

test("normalisers tolerate missing fields and keep venue precision", () => {
  assert.equal(numberToDecimal(0.1 + 0.2), "0.3");
  assert.equal(numberToDecimal(100), "100");
  assert.equal(numberToDecimal("12.340"), "12.340", "decimal strings are kept verbatim");
  assert.equal(numberToDecimal(Number.NaN), undefined);
  assert.deepEqual(normalizeBalances({}), []);
  assert.deepEqual(normalizeBalances({ balances: [{ currency: "USD", buyingPower: "42.10" }] })[0].buyingPower, { value: "42.10", currency: "USD" });
  assert.equal(normalizeBalances({ balances: [{ currency: "USD", buyingPower: "42.10" }] })[0].precisionSource, "string");
  assert.deepEqual(normalizePositionsPage({ positions: {}, nextCursor: "abc", eof: false }), { positions: [], nextCursor: "abc", eof: false });
  assert.deepEqual(normalizeOpenOrders({ orders: [{ marketSlug: "x" }] }), [], "an order without an id is dropped, not invented");
});
