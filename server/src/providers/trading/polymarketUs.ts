/**
 * Prediction Ledger — Polymarket US retail trading adapter (1.10: account reads + targeted cancel).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Verified against docs.polymarket.us and the published `polymarket-us` SDK 0.1.1 on 2026-09-16:
 *   private host  https://api.polymarket.us   (Ed25519-signed: X-PM-Access-Key / X-PM-Timestamp / X-PM-Signature)
 *   public host   https://gateway.polymarket.us
 *   GET /v1/account/balances            → { balances: [{ currency, currentBalance, buyingPower, … }] }  (JSON numbers)
 *   GET /v1/portfolio/positions         → { positions: { <slug>: {…Decimal fields…} }, nextCursor, eof }
 *   GET /v1/orders/open?slugs=…         → { orders: [{ id, marketSlug, intent, state, price:{value,currency}, quantity, cumQuantity, … }] }
 *   POST /v1/order/{id}/cancel          → {} (the order stream / open-orders snapshot decides the real outcome)
 *
 * The SDK is used only as the signed transport (`client.get/post(path, { authenticated: true })`), loaded
 * lazily so the server starts even when the package is absent; the raw JSON is validated here because the
 * SDK's own market/position types are narrower than the API (missing `*Decimal` fields). Production hosts
 * are fixed; a base-URL override exists for tests only and is refused unless `allowTestHosts` is set by
 * the caller — settings never reach it (ACC-04).
 *
 * There is intentionally no create / preview / modify method in this file (1.10: "no submission possible").
 */

import type { DecimalAmount, TradingBalanceSummary, TradingOpenOrderSummary, TradingPositionSummary } from "@prediction-ledger/shared";
import { redactSecrets } from "../../security/redact.js";
import type { TradingCredentials } from "./credentials.js";
import { TradingAdapterError, type CancelResult, type PositionsPage, type TradingAdapter, type TradingErrorCode } from "./types.js";

export const POLYMARKET_US_HOSTS = { gateway: "https://gateway.polymarket.us", api: "https://api.polymarket.us" } as const;
/** Pinned in server/package.json; npm "latest" was 0.1.1 when verified (2026-09-16). */
export const POLYMARKET_US_SDK = { package: "polymarket-us", version: "0.1.1" } as const;

/** The slice of the SDK this adapter relies on (structural; the SDK's own types are not imported). */
export interface SdkClientLike {
  get<T>(path: string, options?: { query?: Record<string, unknown>; authenticated?: boolean }): Promise<T>;
  post<T>(path: string, options?: { body?: unknown; query?: Record<string, unknown>; authenticated?: boolean }): Promise<T>;
}
export interface SdkModuleLike {
  PolymarketUS: new (options?: { keyId?: string; secretKey?: string; gatewayBaseUrl?: string; apiBaseUrl?: string; timeout?: number }) => SdkClientLike;
}

export interface PolymarketUsAdapterOptions {
  /** Test seam: supply a fake SDK module. Default: dynamic import of the pinned package. */
  loadSdk?: () => Promise<SdkModuleLike>;
  /** TEST ONLY. Refused unless `allowTestHosts` is true. */
  apiBaseUrl?: string;
  gatewayBaseUrl?: string;
  allowTestHosts?: boolean;
  timeoutMs?: number;
  /** Minimum spacing between private calls (venue limit is 20 req/s per key; we stay far below). */
  minIntervalMs?: number;
}

const SDK_SPECIFIER = "polymarket-us";

async function defaultLoadSdk(): Promise<SdkModuleLike> {
  // A variable specifier keeps the compiler from resolving the module (it is optional at build time in
  // the sandbox and pinned in package.json for real installs).
  const spec: string = SDK_SPECIFIER;
  try {
    return (await import(spec)) as SdkModuleLike;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TradingAdapterError("sdk_missing", `The ${POLYMARKET_US_SDK.package}@${POLYMARKET_US_SDK.version} package is not installed (${msg.slice(0, 120)}). Run \`npm install\` in the project folder.`);
  }
}

export class PolymarketUsTradingAdapter implements TradingAdapter {
  readonly venue = "polymarket_us" as const;
  readonly hosts: { gateway: string; api: string };
  private readonly loadSdk: () => Promise<SdkModuleLike>;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private sdk?: Promise<SdkModuleLike>;
  private lastCallAt = 0;

  constructor(opts: PolymarketUsAdapterOptions = {}) {
    const api = opts.apiBaseUrl ?? POLYMARKET_US_HOSTS.api;
    const gateway = opts.gatewayBaseUrl ?? POLYMARKET_US_HOSTS.gateway;
    if ((api !== POLYMARKET_US_HOSTS.api || gateway !== POLYMARKET_US_HOSTS.gateway) && !opts.allowTestHosts) {
      throw new TradingAdapterError("host_not_allowed", `Polymarket US hosts are fixed to ${POLYMARKET_US_HOSTS.api} and ${POLYMARKET_US_HOSTS.gateway}; base-URL overrides are test-only.`);
    }
    this.hosts = { gateway, api };
    this.loadSdk = opts.loadSdk ?? defaultLoadSdk;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.minIntervalMs = opts.minIntervalMs ?? 120;
  }

  private async client(creds: TradingCredentials): Promise<SdkClientLike> {
    this.sdk ??= this.loadSdk();
    let mod: SdkModuleLike;
    try {
      mod = await this.sdk;
    } catch (err) {
      this.sdk = undefined;
      if (err instanceof TradingAdapterError) throw err;
      throw new TradingAdapterError("sdk_missing", `The ${POLYMARKET_US_SDK.package} SDK could not be loaded: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
    }
    return new mod.PolymarketUS({ keyId: creds.keyId, secretKey: creds.secretKey, apiBaseUrl: this.hosts.api, gatewayBaseUrl: this.hosts.gateway, timeout: this.timeoutMs });
  }

  private async call<T>(creds: TradingCredentials, fn: (c: SdkClientLike) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const wait = this.lastCallAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
    if (signal?.aborted) throw new TradingAdapterError("timeout", "cancelled");
    try {
      return await fn(await this.client(creds));
    } catch (err) {
      throw mapError(err, [creds.secretKey, creds.keyId]);
    }
  }

  async balances(creds: TradingCredentials, signal?: AbortSignal): Promise<TradingBalanceSummary[]> {
    const raw = await this.call(creds, (c) => c.get<unknown>("/v1/account/balances", { authenticated: true }), signal);
    return normalizeBalances(raw);
  }

  async positions(creds: TradingCredentials, opts: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<PositionsPage> {
    const query: Record<string, unknown> = { limit: opts.limit ?? 100 };
    if (opts.cursor) query.cursor = opts.cursor;
    const raw = await this.call(creds, (c) => c.get<unknown>("/v1/portfolio/positions", { query, authenticated: true }), opts.signal);
    return normalizePositionsPage(raw);
  }

  async openOrders(creds: TradingCredentials, opts: { marketSlugs?: string[]; signal?: AbortSignal } = {}): Promise<TradingOpenOrderSummary[]> {
    const query: Record<string, unknown> = {};
    if (opts.marketSlugs?.length) query.slugs = opts.marketSlugs;
    const raw = await this.call(creds, (c) => c.get<unknown>("/v1/orders/open", { query, authenticated: true }), opts.signal);
    return normalizeOpenOrders(raw);
  }

  async cancelOrder(creds: TradingCredentials, orderId: string, marketSlug: string, signal?: AbortSignal): Promise<CancelResult> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(orderId)) throw new TradingAdapterError("bad_request", "order id has an unexpected shape");
    try {
      await this.call(creds, (c) => c.post<unknown>(`/v1/order/${encodeURIComponent(orderId)}/cancel`, { body: { marketSlug }, authenticated: true }), signal);
      return { orderId, outcome: "requested" };
    } catch (err) {
      if (err instanceof TradingAdapterError && err.code === "not_found") return { orderId, outcome: "not_found", message: err.message };
      throw err;
    }
  }
}

// ---- normalisation (pure, fixture-tested) ----------------------------------------------------------

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** JSON number → decimal string without binary-float noise (≤ 8 dp, trailing zeros trimmed). */
export function numberToDecimal(n: unknown): string | undefined {
  if (typeof n === "string") return /^-?\d+(\.\d+)?$/.test(n.trim()) ? n.trim() : undefined;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const s = n.toFixed(8).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

const amount = (v: unknown, currency = "USD"): DecimalAmount | undefined => {
  const o = obj(v);
  if (o) {
    const value = numberToDecimal(o.value);
    return value === undefined ? undefined : { value, currency: str(o.currency) ?? currency };
  }
  const value = numberToDecimal(v);
  return value === undefined ? undefined : { value, currency };
};

export function normalizeBalances(raw: unknown): TradingBalanceSummary[] {
  const rows = (obj(raw)?.balances as unknown[] | undefined) ?? [];
  return rows.map((r) => {
    const b = obj(r) ?? {};
    const currency = str(b.currency) ?? "USD";
    const anyString = ["currentBalance", "buyingPower", "openOrders"].some((k) => typeof b[k] === "string");
    return {
      currency,
      currentBalance: amount(b.currentBalance, currency),
      buyingPower: amount(b.buyingPower, currency),
      openOrdersNotional: amount(b.openOrders, currency),
      assetNotional: amount(b.assetNotional, currency),
      unsettledFunds: amount(b.unsettledFunds, currency),
      lastUpdated: str(b.lastUpdated),
      precisionSource: anyString ? "string" : "number",
    };
  });
}

export function normalizePositionsPage(raw: unknown): PositionsPage {
  const o = obj(raw) ?? {};
  const map = obj(o.positions) ?? {};
  const positions: TradingPositionSummary[] = [];
  for (const [slug, v] of Object.entries(map)) {
    const p = obj(v) ?? {};
    const meta = obj(p.marketMetadata) ?? {};
    // Prefer the decimal-string fields; the integer ones are documented as deprecated/rounded.
    const net = numberToDecimal(p.netPositionDecimal) ?? numberToDecimal(p.netPosition) ?? "0";
    positions.push({
      marketSlug: str(meta.slug) ?? slug,
      title: str(meta.title),
      outcome: str(meta.outcome),
      eventSlug: str(meta.eventSlug),
      netQuantity: net,
      cost: amount(p.cost),
      realized: amount(p.realized),
      cashValue: amount(p.cashValue),
      expired: p.expired === true,
      updateTime: str(p.updateTime),
    });
  }
  return { positions, nextCursor: str(o.nextCursor), eof: o.eof === true || str(o.nextCursor) === undefined };
}

export function normalizeOpenOrders(raw: unknown): TradingOpenOrderSummary[] {
  const rows = (obj(raw)?.orders as unknown[] | undefined) ?? [];
  return rows.flatMap((r) => {
    const o = obj(r);
    const id = o && str(o.id);
    if (!o || !id) return [];
    return [{
      id,
      marketSlug: str(o.marketSlug) ?? str(obj(o.marketMetadata)?.slug) ?? "",
      intent: str(o.intent) ?? (str(o.outcomeSide) && str(o.action) ? `${o.outcomeSide}/${o.action}` : "unknown"),
      state: str(o.state) ?? "unknown",
      price: amount(o.price),
      quantity: numberToDecimal(o.quantity),
      filledQuantity: numberToDecimal(o.cumQuantity),
      createTime: str(o.createTime) ?? str(o.insertTime),
    }];
  });
}

// ---- error mapping ----------------------------------------------------------------------------------

/** SDK/HTTP error → TradingAdapterError with a stable code and a redacted message. */
export function mapError(err: unknown, secrets: (string | undefined)[]): TradingAdapterError {
  if (err instanceof TradingAdapterError) return new TradingAdapterError(err.code, redactSecrets(err.message, secrets), err.status);
  const e = (typeof err === "object" && err !== null ? err : {}) as { status?: unknown; message?: unknown; name?: unknown; code?: unknown };
  const status = typeof e.status === "number" ? e.status : undefined;
  const message = redactSecrets(typeof e.message === "string" ? e.message : String(err), secrets).slice(0, 300);
  let code: TradingErrorCode = "unknown";
  if (status === 401) code = /timestamp|skew|expired|too old|clock/i.test(message) ? "clock_skew" : "unauthorized";
  else if (status === 403) code = "forbidden";
  else if (status === 404) code = "not_found";
  else if (status === 400) code = /timestamp|skew/i.test(message) ? "clock_skew" : "bad_request";
  else if (status === 408) code = "timeout";
  else if (status === 429) code = "rate_limited";
  else if (status !== undefined && status >= 500) code = "venue_unavailable";
  else if (status === 0 || e.name === "APIConnectionError" || /ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(message)) code = "network";
  else if (e.name === "AbortError" || e.name === "APITimeoutError" || /timed? ?out/i.test(message)) code = "timeout";
  return new TradingAdapterError(code, message || code, status);
}
