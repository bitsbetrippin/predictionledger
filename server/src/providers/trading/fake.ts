/**
 * Prediction Ledger — deterministic fake trading adapter and fake venue (1.10 reads; 1.13 orders, stream, activities).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Used by every default test. Scripted per credential: a key id maps to an account script (balances, positions,
 * open orders) or to a failure code. Every call is recorded so tests can assert counts and payloads.
 *
 * 1.13 adds a tiny venue: per-market order behaviours (fill / partial / none / reject / drop the response after
 * creating the order / time out before creating anything / 5xx), executions emitted on the private stream, an
 * activities ledger, positions derived from fills, external orders and positions, settlement, duplicate and
 * out-of-order stream delivery, dropped stream events, and paging faults — everything the E-tests inject.
 */

import crypto from "node:crypto";
import type { TradingBalanceSummary, TradingOpenOrderSummary, TradingPositionSummary } from "@prediction-ledger/shared";
import { D, Dec } from "../../analysis/decimal.js";
import type { TradingCredentials } from "./credentials.js";
import {
  TradingAdapterError,
  type ActivitiesPage, type ActivityRecord, type CancelResult, type CreateOrderResult, type OrderPreview, type OrderRequest, type PositionsPage, type PrivateStreamEvent, type PrivateStreamHandle,
  type PrivateStreamHandlers, type SubmitFailureClass, type TradingAdapter, type TradingErrorCode, type VenueExecution, type VenueOrder,
} from "./types.js";

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
  method: "balances" | "positions" | "openOrders" | "cancelOrder" | "previewOrder" | "createOrder" | "getOrder" | "activities" | "settlement" | "openPrivateStream";
  keyId: string;
  args?: Record<string, unknown>;
}

/** What the fake venue does with a create call on a market. */
export interface OrderBehaviour {
  mode: "fill" | "partial" | "none" | "reject" | "drop_response" | "timeout" | "error_5xx" | "rate_limit" | "bad_request" | "rest";
  /** Fills to apply, in order, at the given YES prices (partial: the remainder is IOC-canceled). */
  fills?: { quantity: string; yesPrice: string }[];
  /** Fee per contract charged on fills. */
  feePerContract?: string;
  rejectReason?: string;
  /** Delay stream events (ms) after the create response. */
  delayMs?: number;
}

export const fakeBalance = (buyingPower = "100.00", currentBalance = "100.00"): TradingBalanceSummary => ({
  currency: "USD",
  currentBalance: { value: currentBalance, currency: "USD" },
  buyingPower: { value: buyingPower, currency: "USD" },
  openOrdersNotional: { value: "0", currency: "USD" },
  precisionSource: "number",
});

interface FakeVenueOrder extends VenueOrder { executions: VenueExecution[]; ours: boolean; cancelRequested?: boolean }

export class FakeTradingAdapter implements TradingAdapter {
  readonly venue = "polymarket_us" as const;
  readonly hosts = { gateway: "fake://gateway", api: "fake://api" };
  readonly calls: FakeCall[] = [];
  /** When set, every call fails with this code (simulated outage / clock skew / rate limit). */
  outage?: TradingErrorCode;
  private readonly scripts = new Map<string, FakeAccountScript>();

  // ---- fake venue state (1.13) ----
  readonly orders = new Map<string, FakeVenueOrder>();
  readonly activitiesLedger: ActivityRecord[] = [];
  readonly behaviours = new Map<string, OrderBehaviour>();
  readonly settlements = new Map<string, string>();
  private readonly streams: { handlers: PrivateStreamHandlers; open: boolean }[] = [];
  /** When true, stream events are dropped (E11); queued events are kept in `droppedEvents`. */
  dropStream = false;
  readonly droppedEvents: PrivateStreamEvent[] = [];
  /** Deliver each stream event this many times (E09: duplicates). */
  streamDuplicates = 1;
  /** Activities page size and a one-shot failure on the second page (E10). */
  activityPageSize = 100;
  failNextActivityPage = false;
  private seq = 0;
  private balanceOverride?: { buyingPower: string; currentBalance: string };
  /** The fake venue's clock (tests pin it to their fixture instant so windows and ordering are deterministic). */
  now: () => Date = () => new Date();

  script(keyId: string, s: FakeAccountScript): this {
    this.scripts.set(keyId, s);
    return this;
  }

  behave(marketSlug: string, b: OrderBehaviour): this {
    this.behaviours.set(marketSlug, b);
    return this;
  }

  /** Calls that could create or modify an order (create + cancel). */
  get orderCalls(): number {
    return this.calls.filter((c) => c.method === "cancelOrder" || c.method === "createOrder").length;
  }
  get createCalls(): number {
    return this.calls.filter((c) => c.method === "createOrder").length;
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

  // ---- reads (1.10) ----

  async balances(creds: TradingCredentials): Promise<TradingBalanceSummary[]> {
    const s = this.authorize(creds, "balances");
    if (this.balanceOverride) return [fakeBalance(this.balanceOverride.buyingPower, this.balanceOverride.currentBalance)];
    return structuredClone(s.balances ?? [fakeBalance()]);
  }

  setBalance(buyingPower: string, currentBalance = buyingPower): void {
    this.balanceOverride = { buyingPower, currentBalance };
  }

  async positions(creds: TradingCredentials, opts: { cursor?: string; limit?: number } = {}): Promise<PositionsPage> {
    const s = this.authorize(creds, "positions", { cursor: opts.cursor });
    const all = [...(s.positions ?? []), ...this.derivedPositions()];
    const size = s.pageSize ?? 100;
    const start = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    const page = all.slice(start, start + size);
    const next = start + size < all.length ? String(start + size) : undefined;
    return { positions: structuredClone(page), nextCursor: next, eof: next === undefined };
  }

  /** Positions the fake venue holds from filled orders (ours and external), net YES-denominated. */
  derivedPositions(): TradingPositionSummary[] {
    const net = new Map<string, Dec>();
    for (const o of this.orders.values()) {
      const filled = D(o.filledQuantity);
      if (!filled.isPos()) continue;
      const signed = o.side === "no" ? filled.neg() : filled;
      net.set(o.marketSlug, (net.get(o.marketSlug) ?? Dec.ZERO).add(signed));
    }
    for (const [slug, adj] of this.externalPositionAdjustments) net.set(slug, (net.get(slug) ?? Dec.ZERO).add(adj));
    return [...net].filter(([, q]) => !q.isZero()).map(([marketSlug, q]) => ({ marketSlug, netQuantity: q.toString(), expired: false }));
  }
  readonly externalPositionAdjustments = new Map<string, Dec>();

  async openOrders(creds: TradingCredentials, opts: { marketSlugs?: string[] } = {}): Promise<TradingOpenOrderSummary[]> {
    const s = this.authorize(creds, "openOrders", { marketSlugs: opts.marketSlugs });
    const scripted = s.openOrders ?? [];
    const live: TradingOpenOrderSummary[] = [...this.orders.values()].filter((o) => o.state === "open" || o.state === "partial" || o.state === "pending").map((o) => ({
      id: o.id, marketSlug: o.marketSlug, intent: o.intentRaw ?? "", state: o.stateRaw ?? "", price: o.yesPrice ? { value: o.yesPrice, currency: "USD" } : undefined, quantity: o.quantity, filledQuantity: o.filledQuantity, createTime: o.createTime,
    }));
    const rows = [...scripted, ...live];
    return structuredClone(opts.marketSlugs?.length ? rows.filter((o) => opts.marketSlugs!.includes(o.marketSlug)) : rows);
  }

  async cancelOrder(creds: TradingCredentials, orderId: string, marketSlug: string): Promise<CancelResult> {
    const s = this.authorize(creds, "cancelOrder", { orderId, marketSlug });
    if (s.cancel) return s.cancel(orderId);
    const o = this.orders.get(orderId);
    if (!o) return { orderId, outcome: "not_found", message: "no such order" };
    if (o.state === "open" || o.state === "partial" || o.state === "pending") {
      o.cancelRequested = true;
      this.applyCancel(o, "requested by the app");
    }
    return { orderId, outcome: "requested" };
  }

  // ---- orders (1.13) ----

  async previewOrder(creds: TradingCredentials, req: OrderRequest): Promise<OrderPreview> {
    this.authorize(creds, "previewOrder", { ...req });
    const order: VenueOrder = { id: "preview", marketSlug: req.marketSlug, side: req.side, intentRaw: req.side === "yes" ? "ORDER_INTENT_BUY_LONG" : "ORDER_INTENT_BUY_SHORT", state: "unknown", quantity: req.quantity, filledQuantity: "0", yesPrice: req.yesPrice };
    return { order, raw: { order: { id: "preview", marketSlug: req.marketSlug, price: { value: req.yesPrice, currency: "USD" }, quantity: Number(req.quantity) } } };
  }

  async createOrder(creds: TradingCredentials, req: OrderRequest): Promise<CreateOrderResult> {
    this.authorize(creds, "createOrder", { ...req });
    const b = this.behaviours.get(req.marketSlug) ?? { mode: "fill" as const };
    if (b.mode === "timeout") throw new TradingAdapterError("timeout", "Request timeout", 408);
    if (b.mode === "error_5xx") throw new TradingAdapterError("venue_unavailable", "fake 503", 503);
    if (b.mode === "rate_limit") throw new TradingAdapterError("rate_limited", "fake 429", 429);
    if (b.mode === "bad_request") throw new TradingAdapterError("bad_request", "fake 400: ORD_REJECT_REASON_INVALID_PRICE_INCREMENT", 400);
    const id = `ord-${++this.seq}`;
    const order: FakeVenueOrder = {
      id, marketSlug: req.marketSlug, side: req.side, intentRaw: req.side === "yes" ? "ORDER_INTENT_BUY_LONG" : "ORDER_INTENT_BUY_SHORT", stateRaw: "ORDER_STATE_PENDING_NEW", state: "pending", quantity: req.quantity, filledQuantity: "0", leavesQuantity: req.quantity,
      yesPrice: req.yesPrice, feesCollected: "0", createTime: this.now().toISOString(), executions: [], ours: true,
    };
    this.orders.set(id, order);
    const run = () => this.runBehaviour(order, b);
    if (b.delayMs) setTimeout(run, b.delayMs); else run();
    if (b.mode === "drop_response") throw new TradingAdapterError("timeout", "Request timeout (response lost after the venue created the order)", 408);
    return { orderId: id, executions: [], raw: { id } };
  }

  classifySubmitFailure(err: unknown): SubmitFailureClass {
    const code = err instanceof TradingAdapterError ? err.code : "unknown";
    return code === "bad_request" || code === "unauthorized" || code === "forbidden" || code === "not_found" || code === "rate_limited" || code === "clock_skew" ? "not_created" : "ambiguous";
  }

  private runBehaviour(order: FakeVenueOrder, b: OrderBehaviour): void {
    this.emitExecution(order, { type: "new", rawType: "EXECUTION_TYPE_NEW" });
    order.state = "open"; order.stateRaw = "ORDER_STATE_NEW";
    if (b.mode === "reject") {
      order.state = "rejected"; order.stateRaw = "ORDER_STATE_REJECTED";
      this.emitExecution(order, { type: "rejected", rawType: "EXECUTION_TYPE_REJECTED", rejectReason: b.rejectReason ?? "ORD_REJECT_REASON_PRICE_OUT_OF_BOUNDS", text: "rejected by the exchange" });
      return;
    }
    // "rest": the venue acknowledged the order but has not processed the IOC yet (used to race a cancel against a late fill).
    if (b.mode === "rest") return;
    const fills = b.mode === "none" ? [] : b.fills ?? [{ quantity: order.quantity!, yesPrice: order.yesPrice! }];
    for (const f of fills) this.fill(order, f.quantity, f.yesPrice, b.feePerContract ?? "0");
    if (D(order.filledQuantity).lt(order.quantity!)) this.applyCancel(order, "IOC remainder");
  }

  /** Apply a fill on an order (also used by tests to fill during a cancel, E10). */
  fill(order: FakeVenueOrder, quantity: string, yesPrice: string, feePerContract = "0"): VenueExecution {
    const q = D(quantity);
    order.filledQuantity = D(order.filledQuantity).add(q).toString();
    order.leavesQuantity = D(order.quantity ?? "0").sub(order.filledQuantity).toString();
    const fee = D(feePerContract).mul(q).toString();
    order.feesCollected = D(order.feesCollected ?? "0").add(fee).toString();
    const prevCost = D(order.avgPrice ?? "0").mul(D(order.filledQuantity).sub(q));
    order.avgPrice = prevCost.add(D(yesPrice).mul(q)).div(order.filledQuantity, "half_up").round(4).toString();
    const full = D(order.filledQuantity).gte(order.quantity ?? "0");
    order.state = full ? "filled" : "partial";
    order.stateRaw = full ? "ORDER_STATE_FILLED" : "ORDER_STATE_PARTIALLY_FILLED";
    const tradeId = `trd-${++this.seq}`;
    const ex = this.emitExecution(order, { type: full ? "fill" : "partial_fill", rawType: full ? "EXECUTION_TYPE_FILL" : "EXECUTION_TYPE_PARTIAL_FILL", quantity: q.toString(), yesPrice, fee, tradeId });
    // Documented shape: a trade activity carries no order id and no side (attribution is the app's problem, E07/E11).
    this.activitiesLedger.push({ id: `trade:${tradeId}`, kind: "trade", rawType: "ACTIVITY_TYPE_TRADE", marketSlug: order.marketSlug, tradeId, quantity: q.toString(), yesPrice, at: ex.at, raw: { fake: true } });
    return ex;
  }

  applyCancel(order: FakeVenueOrder, reason: string): void {
    if (order.state === "filled" || order.state === "canceled" || order.state === "rejected") return;
    order.state = "canceled"; order.stateRaw = "ORDER_STATE_CANCELED";
    this.emitExecution(order, { type: "canceled", rawType: "EXECUTION_TYPE_CANCELED", text: reason });
  }

  private emitExecution(order: FakeVenueOrder, partial: Partial<VenueExecution> & { type: VenueExecution["type"] }): VenueExecution {
    const ex: VenueExecution = { id: `exe-${++this.seq}`, orderId: order.id, marketSlug: order.marketSlug, at: this.now().toISOString(), order: this.snapshot(order), ...partial };
    order.executions.push(ex);
    this.deliver({ kind: "execution", execution: ex });
    return ex;
  }

  snapshot(order: FakeVenueOrder): VenueOrder {
    const { executions: _e, ours: _o, cancelRequested: _c, ...rest } = order;
    return structuredClone(rest);
  }

  /** Re-deliver a past execution (E09: duplicates / out of order). */
  redeliver(execution: VenueExecution): void {
    this.deliver({ kind: "execution", execution: structuredClone(execution) });
  }

  private deliver(event: PrivateStreamEvent): void {
    if (this.dropStream) { this.droppedEvents.push(event); return; }
    for (const s of this.streams) if (s.open) for (let i = 0; i < this.streamDuplicates; i++) s.handlers.onEvent(structuredClone(event));
  }

  /** An order the app did not place (external / manual). */
  externalOrder(marketSlug: string, side: "yes" | "no", quantity: string, yesPrice: string, opts: { fill?: boolean; createTime?: string } = {}): FakeVenueOrder {
    const id = `ext-${++this.seq}`;
    const order: FakeVenueOrder = { id, marketSlug, side, intentRaw: side === "yes" ? "ORDER_INTENT_BUY_LONG" : "ORDER_INTENT_BUY_SHORT", stateRaw: "ORDER_STATE_NEW", state: "open", quantity, filledQuantity: "0", leavesQuantity: quantity, yesPrice, feesCollected: "0", createTime: opts.createTime ?? this.now().toISOString(), executions: [], ours: false };
    this.orders.set(id, order);
    if (opts.fill) this.fill(order, quantity, yesPrice);
    return order;
  }

  /** An external exit: the venue position shrinks without any app order (E11). */
  externalExit(marketSlug: string, quantity: string): void {
    this.externalPositionAdjustments.set(marketSlug, (this.externalPositionAdjustments.get(marketSlug) ?? Dec.ZERO).sub(quantity));
    const tradeId = `trd-${++this.seq}`;
    this.activitiesLedger.push({ id: `trade:${tradeId}`, kind: "trade", rawType: "ACTIVITY_TYPE_TRADE", marketSlug, tradeId, quantity: quantity, yesPrice: "0.5", at: this.now().toISOString(), raw: { fake: true } });
  }

  /** Official settlement of a market: resolution activity + settlement price; positions go to zero. */
  settle(marketSlug: string, outcome: "yes" | "no" | "void", opts: { correction?: boolean } = {}): void {
    const price = outcome === "yes" ? "1" : outcome === "no" ? "0" : "0.5";
    this.settlements.set(marketSlug, price);
    const before = this.derivedPositions().find((p) => p.marketSlug === marketSlug)?.netQuantity ?? "0";
    for (const o of this.orders.values()) if (o.marketSlug === marketSlug) { o.filledQuantity = "0"; }
    this.externalPositionAdjustments.delete(marketSlug);
    this.activitiesLedger.push({ id: `resolution:${marketSlug}:${++this.seq}`, kind: "position_resolution", rawType: opts.correction ? "ACTIVITY_TYPE_POSITION_RESOLUTION" : "ACTIVITY_TYPE_POSITION_RESOLUTION", marketSlug, at: this.now().toISOString(), resolutionSide: outcome === "yes" ? "POSITION_RESOLUTION_SIDE_LONG" : outcome === "no" ? "POSITION_RESOLUTION_SIDE_SHORT" : "POSITION_RESOLUTION_SIDE_NEUTRAL", positionBefore: before, positionAfter: "0", raw: { fake: true, correction: opts.correction === true, settlement: price } });
  }

  async getOrder(creds: TradingCredentials, orderId: string): Promise<VenueOrder | undefined> {
    this.authorize(creds, "getOrder", { orderId });
    const o = this.orders.get(orderId);
    return o ? this.snapshot(o) : undefined;
  }

  async activities(creds: TradingCredentials, opts: { cursor?: string; limit?: number; marketSlug?: string } = {}): Promise<ActivitiesPage> {
    this.authorize(creds, "activities", { cursor: opts.cursor, marketSlug: opts.marketSlug });
    const rows = opts.marketSlug ? this.activitiesLedger.filter((a) => a.marketSlug === opts.marketSlug) : this.activitiesLedger;
    const start = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    if (start > 0 && this.failNextActivityPage) { this.failNextActivityPage = false; throw new TradingAdapterError("network", "connection reset mid-snapshot", 0); }
    const page = rows.slice(start, start + this.activityPageSize);
    const next = start + this.activityPageSize < rows.length ? String(start + this.activityPageSize) : undefined;
    return { activities: structuredClone(page), nextCursor: next, eof: next === undefined };
  }

  async settlement(marketSlug: string): Promise<{ price: string } | undefined> {
    this.calls.push({ method: "settlement", keyId: "-", args: { marketSlug } });
    const p = this.settlements.get(marketSlug);
    return p === undefined ? undefined : { price: p };
  }

  async openPrivateStream(creds: TradingCredentials, handlers: PrivateStreamHandlers): Promise<PrivateStreamHandle> {
    this.authorize(creds, "openPrivateStream");
    const entry = { handlers, open: true };
    this.streams.push(entry);
    handlers.onEvent({ kind: "order_snapshot", orders: [...this.orders.values()].filter((o) => o.state === "open" || o.state === "partial" || o.state === "pending").map((o) => this.snapshot(o)), eof: true });
    return { close: () => { entry.open = false; }, get connected() { return entry.open; } };
  }

  /** Simulate the venue dropping every stream connection (E10/E11). */
  disconnectStreams(): void {
    for (const s of this.streams) if (s.open) { s.open = false; s.handlers.onClose("fake disconnect"); }
  }

  /** Deliver what was dropped while `dropStream` was on (as if the venue had them all along — they are already in the ledger). */
  flushDropped(): PrivateStreamEvent[] {
    const out = this.droppedEvents.splice(0);
    return out;
  }

  static id(): string { return crypto.randomUUID(); }
}
