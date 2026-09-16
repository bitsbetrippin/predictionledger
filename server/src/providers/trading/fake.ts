/**
 * Prediction Ledger — deterministic fake trading adapter (1.10). Used by every default test.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Scripted per credential: a key id maps to an account script (balances, positions, open orders) or to a
 * failure code. Every call is recorded so tests can assert counts and payloads — including that no
 * create/preview call can ever be recorded, because the interface has none.
 */

import type { TradingBalanceSummary, TradingOpenOrderSummary, TradingPositionSummary } from "@prediction-ledger/shared";
import type { TradingCredentials } from "./credentials.js";
import { TradingAdapterError, type CancelResult, type PositionsPage, type TradingAdapter, type TradingErrorCode } from "./types.js";

export interface FakeAccountScript {
  /** The secret this key id must be presented with; any other secret → unauthorized (signature rejected). */
  secretKey: string;
  balances?: TradingBalanceSummary[];
  positions?: TradingPositionSummary[];
  openOrders?: TradingOpenOrderSummary[];
  /** Fail every call with this code (e.g. "forbidden" for a restricted/unverified account). */
  failWith?: TradingErrorCode;
  failMessage?: string;
  /** Page size for positions, to exercise cursor paging. */
  pageSize?: number;
  cancel?: (orderId: string) => CancelResult;
}

export interface FakeCall {
  method: "balances" | "positions" | "openOrders" | "cancelOrder";
  keyId: string;
  args?: Record<string, unknown>;
}

export const fakeBalance = (buyingPower = "100.00", currentBalance = "100.00"): TradingBalanceSummary => ({
  currency: "USD",
  currentBalance: { value: currentBalance, currency: "USD" },
  buyingPower: { value: buyingPower, currency: "USD" },
  openOrdersNotional: { value: "0", currency: "USD" },
  precisionSource: "number",
});

export class FakeTradingAdapter implements TradingAdapter {
  readonly venue = "polymarket_us" as const;
  readonly hosts = { gateway: "fake://gateway", api: "fake://api" };
  readonly calls: FakeCall[] = [];
  /** When set, every call fails with this code (simulated outage / clock skew / rate limit). */
  outage?: TradingErrorCode;
  private readonly scripts = new Map<string, FakeAccountScript>();

  script(keyId: string, s: FakeAccountScript): this {
    this.scripts.set(keyId, s);
    return this;
  }

  /** Calls that could create or modify an order — always 0 (there is no such method). */
  get orderCalls(): number {
    return this.calls.filter((c) => c.method === "cancelOrder").length;
  }

  private authorize(creds: TradingCredentials, method: FakeCall["method"], args?: Record<string, unknown>): FakeAccountScript {
    this.calls.push({ method, keyId: creds.keyId, args });
    if (this.outage) throw new TradingAdapterError(this.outage, `fake ${this.outage}`, this.outage === "venue_unavailable" ? 503 : this.outage === "rate_limited" ? 429 : this.outage === "clock_skew" ? 401 : undefined);
    const s = this.scripts.get(creds.keyId);
    if (!s) throw new TradingAdapterError("unauthorized", "Unauthorized: unknown API key", 401);
    if (s.secretKey !== creds.secretKey) throw new TradingAdapterError("unauthorized", "Unauthorized: signature verification failed", 401);
    if (s.failWith) throw new TradingAdapterError(s.failWith, s.failMessage ?? `fake ${s.failWith}`, s.failWith === "forbidden" ? 403 : s.failWith === "unauthorized" ? 401 : undefined);
    return s;
  }

  async balances(creds: TradingCredentials): Promise<TradingBalanceSummary[]> {
    return structuredClone(this.authorize(creds, "balances").balances ?? [fakeBalance()]);
  }

  async positions(creds: TradingCredentials, opts: { cursor?: string; limit?: number } = {}): Promise<PositionsPage> {
    const s = this.authorize(creds, "positions", { cursor: opts.cursor });
    const all = s.positions ?? [];
    const size = s.pageSize ?? 100;
    const start = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    const page = all.slice(start, start + size);
    const next = start + size < all.length ? String(start + size) : undefined;
    return { positions: structuredClone(page), nextCursor: next, eof: next === undefined };
  }

  async openOrders(creds: TradingCredentials, opts: { marketSlugs?: string[] } = {}): Promise<TradingOpenOrderSummary[]> {
    const s = this.authorize(creds, "openOrders", { marketSlugs: opts.marketSlugs });
    const rows = s.openOrders ?? [];
    return structuredClone(opts.marketSlugs?.length ? rows.filter((o) => opts.marketSlugs!.includes(o.marketSlug)) : rows);
  }

  async cancelOrder(creds: TradingCredentials, orderId: string, marketSlug: string): Promise<CancelResult> {
    const s = this.authorize(creds, "cancelOrder", { orderId, marketSlug });
    return s.cancel ? s.cancel(orderId) : { orderId, outcome: "requested" };
  }
}
