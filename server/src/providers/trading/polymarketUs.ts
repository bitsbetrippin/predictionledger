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
 * 1.13 (EXE-01) adds the order API, verified the same way:
 *   POST /v1/order/preview {request}      → { order }                      (read-only)
 *   POST /v1/orders                       → { id, executions? }            (an id is acceptance, never a fill)
 *   GET  /v1/order/{id}                   → { order }                      (state, cumQuantity, avgPx, commissions)
 *   GET  /v1/portfolio/activities         → { activities, nextCursor, eof } (trades, position resolutions, balances)
 *   GET  gateway /v1/markets/{slug}/settlement → { slug, settlement }
 *   wss://api.polymarket.us/v1/ws/private (SDK `ws.private()`; signed handshake; execution events with tradeId)
 * `price.value` is always the YES price and is passed through untouched; the SDK posts the body verbatim.
 * The SDK raises APIError(408) on its own timeout and APIError(0) on network failure: those, and 5xx, are the
 * ambiguous class for a create call (an order may exist); 400/401/403/404/429 mean no order was created.
 */

import crypto from "node:crypto";
import type { DecimalAmount, TradingBalanceSummary, TradingOpenOrderSummary, TradingPositionSummary } from "@prediction-ledger/shared";
import { redactSecrets } from "../../security/redact.js";
import { normalizeExecutionType, normalizeOrderState, sideOfIntent, toVenueCreateBody } from "../../analysis/orderState.js";
import type { TradingCredentials } from "./credentials.js";
import {
  TradingAdapterError,
  type ActivitiesPage, type ActivityRecord, type CancelResult, type CreateOrderResult, type OrderPreview, type OrderRequest, type PositionsPage, type PrivateStreamHandle, type PrivateStreamHandlers,
  type SubmitFailureClass, type TradingAdapter, type TradingErrorCode, type VenueExecution, type VenueOrder,
} from "./types.js";

export const POLYMARKET_US_HOSTS = { gateway: "https://gateway.polymarket.us", api: "https://api.polymarket.us" } as const;
/** Pinned in server/package.json; npm "latest" was 0.1.1 when verified (2026-09-16). */
export const POLYMARKET_US_SDK = { package: "polymarket-us", version: "0.1.1" } as const;

/** The slice of the SDK this adapter relies on (structural; the SDK's own types are not imported). */
export interface SdkClientLike {
  get<T>(path: string, options?: { query?: Record<string, unknown>; authenticated?: boolean }): Promise<T>;
  post<T>(path: string, options?: { body?: unknown; query?: Record<string, unknown>; authenticated?: boolean }): Promise<T>;
  /** Present on polymarket-us@0.1.1 (`client.ws.private()`); optional so a fake client can omit it. */
  ws?: { private(): SdkPrivateSocketLike };
}
/** The private WebSocket the SDK exposes (structural). */
export interface SdkPrivateSocketLike {
  connect(): Promise<void>;
  subscribeOrders(requestId: string, marketSlugs?: string[]): void;
  subscribePositions(requestId: string, marketSlugs?: string[]): void;
  subscribeAccountBalance(requestId: string): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  close(): void;
  readonly isConnected: boolean;
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

  // ---- 1.13 (EXE-01): order API --------------------------------------------------------------------------

  async previewOrder(creds: TradingCredentials, req: OrderRequest, signal?: AbortSignal): Promise<OrderPreview> {
    const body = toVenueCreateBody(req);
    const raw = await this.call(creds, (c) => c.post<unknown>("/v1/order/preview", { body: { request: body }, authenticated: true }), signal);
    const order = obj(obj(raw)?.order);
    return { order: order ? normalizeOrder(order) : undefined, raw };
  }

  async createOrder(creds: TradingCredentials, req: OrderRequest, signal?: AbortSignal): Promise<CreateOrderResult> {
    const body = toVenueCreateBody(req);
    const raw = await this.call(creds, (c) => c.post<unknown>("/v1/orders", { body, authenticated: true }), signal);
    const o = obj(raw) ?? {};
    const id = str(o.id);
    if (!id) throw new TradingAdapterError("unknown", "The venue answered the create call without an order id; treat as ambiguous.");
    const executions = ((o.executions as unknown[] | undefined) ?? []).flatMap((e) => { const x = normalizeExecution(e, id); return x ? [x] : []; });
    return { orderId: id, executions, raw };
  }

  classifySubmitFailure(err: unknown): SubmitFailureClass {
    // 2.0 (RV-12): a 429 is NOT proof that nothing was created — the venue documents no ordering between throttling and
    // order creation and offers no idempotency key — so it is treated as ambiguous (held for the owner), never resent.
    const code = err instanceof TradingAdapterError ? err.code : "unknown";
    return code === "bad_request" || code === "unauthorized" || code === "forbidden" || code === "not_found" || code === "clock_skew" || code === "host_not_allowed" || code === "sdk_missing" ? "not_created" : "ambiguous";
  }

  async getOrder(creds: TradingCredentials, orderId: string, signal?: AbortSignal): Promise<VenueOrder | undefined> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(orderId)) throw new TradingAdapterError("bad_request", "order id has an unexpected shape");
    try {
      const raw = await this.call(creds, (c) => c.get<unknown>(`/v1/order/${encodeURIComponent(orderId)}`, { authenticated: true }), signal);
      const order = obj(obj(raw)?.order) ?? obj(raw);
      return order && str(order.id) ? normalizeOrder(order) : undefined;
    } catch (err) {
      if (err instanceof TradingAdapterError && err.code === "not_found") return undefined;
      throw err;
    }
  }

  async activities(creds: TradingCredentials, opts: { cursor?: string; limit?: number; marketSlug?: string; signal?: AbortSignal } = {}): Promise<ActivitiesPage> {
    const query: Record<string, unknown> = { limit: opts.limit ?? 100 };
    if (opts.cursor) query.cursor = opts.cursor;
    if (opts.marketSlug) query.marketSlug = opts.marketSlug;
    const raw = await this.call(creds, (c) => c.get<unknown>("/v1/portfolio/activities", { query, authenticated: true }), opts.signal);
    return normalizeActivities(raw);
  }

  async settlement(marketSlug: string, signal?: AbortSignal): Promise<{ price: string } | undefined> {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(marketSlug)) throw new TradingAdapterError("bad_request", "market slug has an unexpected shape");
    const res = await fetch(`${this.hosts.gateway}/v1/markets/${encodeURIComponent(marketSlug)}/settlement`, { signal, headers: { accept: "application/json" } });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new TradingAdapterError(res.status >= 500 ? "venue_unavailable" : "unknown", `settlement lookup failed: HTTP ${res.status}`, res.status);
    const j = obj(await res.json()) ?? {};
    const price = numberToDecimal(j.settlement);
    return price === undefined ? undefined : { price };
  }

  async openPrivateStream(creds: TradingCredentials, handlers: PrivateStreamHandlers): Promise<PrivateStreamHandle> {
    const client = await this.client(creds);
    if (!client.ws) throw new TradingAdapterError("sdk_missing", "The installed SDK exposes no private WebSocket client.");
    const socket = client.ws.private();
    const secrets = [creds.secretKey, creds.keyId];
    socket.on("orderSnapshot", (m: unknown) => {
      const snap = obj(obj(m)?.orderSubscriptionSnapshot) ?? obj(obj(m)?.ordersSnapshot) ?? {};
      const orders = ((snap.orders as unknown[] | undefined) ?? []).flatMap((o) => { const x = obj(o); return x && str(x.id) ? [normalizeOrder(x)] : []; });
      handlers.onEvent({ kind: "order_snapshot", orders, eof: snap.eof === true });
    });
    socket.on("orderUpdate", (m: unknown) => {
      const upd = obj(obj(m)?.orderSubscriptionUpdate) ?? obj(obj(m)?.orderUpdate) ?? {};
      const ex = normalizeExecution(upd.execution, undefined);
      if (ex) handlers.onEvent({ kind: "execution", execution: ex });
    });
    socket.on("positionUpdate", (m: unknown) => {
      const upd = obj(obj(m)?.positionSubscriptionUpdate) ?? obj(obj(m)?.positionUpdate) ?? {};
      const pos = obj(upd.position) ?? obj(upd.afterPosition) ?? {};
      const slug = str(upd.marketSlug) ?? str(obj(pos.marketMetadata)?.slug);
      const net = numberToDecimal(pos.netPositionDecimal) ?? numberToDecimal(pos.netPosition);
      if (slug && net !== undefined) handlers.onEvent({ kind: "position", marketSlug: slug, netQuantity: net, at: str(upd.updateTime) });
    });
    socket.on("accountBalanceUpdate", (m: unknown) => {
      const upd = obj(obj(m)?.accountBalanceSubscriptionUpdate) ?? obj(obj(m)?.accountBalanceUpdate) ?? {};
      handlers.onEvent({ kind: "balance", buyingPower: numberToDecimal(upd.buyingPower), balance: numberToDecimal(upd.balance) });
    });
    socket.on("heartbeat", () => handlers.onEvent({ kind: "heartbeat" }));
    socket.on("error", (e: unknown) => handlers.onEvent({ kind: "error", message: redactSecrets(e instanceof Error ? e.message : String(e), secrets).slice(0, 200) }));
    socket.on("close", () => handlers.onClose("closed"));
    try {
      await socket.connect();
      socket.subscribeOrders("orders");
      socket.subscribePositions("positions");
      socket.subscribeAccountBalance("balance");
    } catch (err) {
      throw mapError(err, secrets);
    }
    return { close: () => socket.close(), get connected() { return socket.isConnected; } };
  }
}

// ---- 1.13 normalisation --------------------------------------------------------------------------------

export function normalizeOrder(o: Raw): VenueOrder {
  const intentRaw = str(o.intent) ?? (str(o.outcomeSide) && str(o.action) ? `${o.outcomeSide}/${o.action}` : undefined);
  return {
    id: str(o.id) ?? "",
    marketSlug: str(o.marketSlug) ?? str(obj(o.marketMetadata)?.slug) ?? "",
    intentRaw,
    side: sideOfIntent(intentRaw),
    stateRaw: str(o.state),
    state: normalizeOrderState(str(o.state)),
    quantity: numberToDecimal(o.quantity),
    filledQuantity: numberToDecimal(o.cumQuantity) ?? "0",
    leavesQuantity: numberToDecimal(o.leavesQuantity),
    yesPrice: amount(o.price)?.value,
    avgPrice: amount(o.avgPx)?.value,
    feesCollected: amount(o.commissionNotionalTotalCollected)?.value,
    createTime: str(o.createTime) ?? str(o.insertTime),
    updateTime: str(o.updateTime),
    raw: o,
  };
}

export function normalizeExecution(e: unknown, fallbackOrderId: string | undefined): VenueExecution | undefined {
  const x = obj(e);
  if (!x) return undefined;
  const order = obj(x.order);
  const orderId = str(order?.id) ?? fallbackOrderId;
  const id = str(x.id);
  if (!orderId || !id) return undefined;
  return {
    id,
    orderId,
    marketSlug: str(order?.marketSlug) ?? str(obj(order?.marketMetadata)?.slug),
    type: normalizeExecutionType(str(x.type)),
    rawType: str(x.type),
    quantity: numberToDecimal(x.lastShares),
    yesPrice: amount(x.lastPx)?.value,
    fee: amount(x.commissionNotionalCollected)?.value,
    tradeId: str(x.tradeId),
    at: str(x.transactTime),
    rejectReason: str(x.orderRejectReason),
    text: str(x.text),
    order: order ? normalizeOrder(order) : undefined,
    raw: x,
  };
}

export function normalizeActivities(raw: unknown): ActivitiesPage {
  const o = obj(raw) ?? {};
  const rows = (o.activities as unknown[] | undefined) ?? [];
  const activities: ActivityRecord[] = rows.flatMap((r): ActivityRecord[] => {
    const a = obj(r);
    if (!a) return [];
    const type = str(a.type) ?? "unknown";
    const trade = obj(a.trade);
    const res = obj(a.positionResolution);
    const bal = obj(a.accountBalanceChange);
    if (trade) {
      const id = str(trade.id) ?? crypto.createHash("sha256").update(JSON.stringify(trade)).digest("hex").slice(0, 32);
      return [{ id: `trade:${id}`, kind: "trade" as const, rawType: type, marketSlug: str(trade.marketSlug), tradeId: str(trade.id), quantity: numberToDecimal(trade.qtyDecimal) ?? numberToDecimal(trade.qty), yesPrice: amount(trade.price)?.value, realizedPnl: amount(trade.realizedPnl)?.value, costBasis: amount(trade.costBasis)?.value, at: str(trade.createTime) ?? str(trade.updateTime), raw: a }];
    }
    if (res) {
      const before = obj(res.beforePosition), after = obj(res.afterPosition);
      const key = crypto.createHash("sha256").update(JSON.stringify({ m: res.marketSlug, t: res.updateTime, s: res.side, b: before?.netPositionDecimal ?? before?.netPosition })).digest("hex").slice(0, 32);
      return [{ id: `resolution:${key}`, kind: "position_resolution" as const, rawType: type, marketSlug: str(res.marketSlug), tradeId: str(res.tradeId), at: str(res.updateTime), resolutionSide: str(res.side), positionBefore: numberToDecimal(before?.netPositionDecimal) ?? numberToDecimal(before?.netPosition), positionAfter: numberToDecimal(after?.netPositionDecimal) ?? numberToDecimal(after?.netPosition), realizedPnl: amount(after?.realized)?.value, raw: a }];
    }
    if (bal) {
      const id = str(bal.transactionId) ?? crypto.createHash("sha256").update(JSON.stringify(bal)).digest("hex").slice(0, 32);
      return [{ id: `balance:${id}`, kind: "balance_change" as const, rawType: type, amount: amount(bal.amount)?.value, at: str(bal.updateTime) ?? str(bal.createTime), raw: a }];
    }
    return [{ id: `other:${crypto.createHash("sha256").update(JSON.stringify(a)).digest("hex").slice(0, 32)}`, kind: "other" as const, rawType: type, raw: a }];
  });
  return { activities, nextCursor: str(o.nextCursor), eof: o.eof === true || str(o.nextCursor) === undefined };
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
