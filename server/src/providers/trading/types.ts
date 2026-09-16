/**
 * Prediction Ledger — TradingAdapter interface (1.10): the only code path that may carry a venue credential.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Deliberately separate from `MarketProvider` (read-only public data). In 1.10 the adapter exposes
 * account *reads* and a targeted cancel — there is no create/preview/modify method, so order submission
 * is impossible by construction until the 1.13 gate adds it (EXE-01). Business logic uses only these
 * types; SDK types never cross this boundary.
 *
 * Every method takes the credentials explicitly (nothing is cached in the adapter), so the caller —
 * TradingAccountService, which owns the vault — decides exactly when key material is in memory.
 */

import type { TradingBalanceSummary, TradingOpenOrderSummary, TradingPositionSummary, TradingVenueId } from "@prediction-ledger/shared";
import type { TradingCredentials } from "./credentials.js";

export type TradingErrorCode =
  | "unauthorized" // 401: key unknown, revoked, or signature rejected
  | "forbidden" // 403: account not permitted (unverified / restricted)
  | "clock_skew" // venue rejected the timestamp (> 30 s from server time)
  | "rate_limited" // 429
  | "venue_unavailable" // 5xx
  | "not_found"
  | "bad_request"
  | "network" // DNS/TLS/connection reset
  | "timeout"
  | "sdk_missing" // polymarket-us package not installed
  | "host_not_allowed"
  | "unknown";

export class TradingAdapterError extends Error {
  constructor(
    public readonly code: TradingErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "TradingAdapterError";
  }
}

export interface PositionsPage {
  positions: TradingPositionSummary[];
  nextCursor?: string;
  eof: boolean;
}

export interface CancelResult {
  orderId: string;
  /** "requested" = the venue accepted the cancel request; the order stream/open-orders snapshot decides the outcome. */
  outcome: "requested" | "not_found" | "failed";
  message?: string;
}

/**
 * 1.13 (EXE-01): an order request in the app's own terms. `yesPrice` is the YES-denominated limit the decision
 * computed (a NO buy already carries 1 − chosen cost, rounded up to the tick, exactly once). `quantity` is a decimal
 * string in contracts. The adapter maps this to the venue's wire shape and never converts prices.
 */
export interface OrderRequest {
  marketSlug: string;
  side: "yes" | "no";
  action: "buy";
  yesPrice: string;
  quantity: string;
  timeInForce: "IOC";
  /** Manual (owner-confirmed) vs automatic (scheduled) order indicator, as the venue defines it. */
  manual: boolean;
}

export type VenueOrderState = "pending" | "open" | "partial" | "filled" | "canceled" | "expired" | "rejected" | "unknown";

export interface VenueOrder {
  id: string;
  marketSlug: string;
  intentRaw?: string;
  side?: "yes" | "no";
  stateRaw?: string;
  state: VenueOrderState;
  quantity?: string;
  filledQuantity: string;
  leavesQuantity?: string;
  yesPrice?: string;
  avgPrice?: string;
  feesCollected?: string;
  createTime?: string;
  updateTime?: string;
  raw?: unknown;
}

export type VenueExecutionType = "new" | "partial_fill" | "fill" | "canceled" | "rejected" | "expired" | "replace" | "done_for_day" | "unknown";

export interface VenueExecution {
  id: string;
  orderId: string;
  marketSlug?: string;
  type: VenueExecutionType;
  rawType?: string;
  quantity?: string;
  yesPrice?: string;
  fee?: string;
  tradeId?: string;
  at?: string;
  rejectReason?: string;
  text?: string;
  /** The order as the venue described it at this execution, when included. */
  order?: VenueOrder;
  raw?: unknown;
}

export interface OrderPreview {
  order?: VenueOrder;
  raw: unknown;
}

export interface CreateOrderResult {
  orderId: string;
  executions: VenueExecution[];
  raw: unknown;
}

/** Whether a failed create call can have left an order behind (EXE-04). */
export type SubmitFailureClass = "not_created" | "ambiguous";

export interface ActivityRecord {
  /** Stable id for dedupe: the trade id, or a hash of the record. */
  id: string;
  kind: "trade" | "position_resolution" | "balance_change" | "other";
  rawType: string;
  marketSlug?: string;
  tradeId?: string;
  quantity?: string;
  yesPrice?: string;
  realizedPnl?: string;
  costBasis?: string;
  at?: string;
  resolutionSide?: string;
  positionBefore?: string;
  positionAfter?: string;
  amount?: string;
  raw: unknown;
}

export interface ActivitiesPage {
  activities: ActivityRecord[];
  nextCursor?: string;
  eof: boolean;
}

export type PrivateStreamEvent =
  | { kind: "order_snapshot"; orders: VenueOrder[]; eof: boolean }
  | { kind: "execution"; execution: VenueExecution }
  | { kind: "position"; marketSlug: string; netQuantity: string; at?: string }
  | { kind: "balance"; buyingPower?: string; balance?: string }
  | { kind: "heartbeat" }
  | { kind: "error"; message: string };

export interface PrivateStreamHandle {
  close(): void;
  readonly connected: boolean;
}

export interface PrivateStreamHandlers {
  onEvent(event: PrivateStreamEvent): void;
  onClose(reason?: string): void;
}

export interface TradingAdapter {
  readonly venue: TradingVenueId;
  /** Production hosts this adapter will talk to (for display and allowlist checks). */
  readonly hosts: { gateway: string; api: string };
  /** Authenticated read used by the connection test. Performs no trade. */
  balances(creds: TradingCredentials, signal?: AbortSignal): Promise<TradingBalanceSummary[]>;
  /** One page of positions; callers page until `eof` before inferring absence (EXE-07). */
  positions(creds: TradingCredentials, opts?: { cursor?: string; limit?: number; signal?: AbortSignal }): Promise<PositionsPage>;
  openOrders(creds: TradingCredentials, opts?: { marketSlugs?: string[]; signal?: AbortSignal }): Promise<TradingOpenOrderSummary[]>;
  /** Targeted cancel of one order by venue id (ACC-06). Never account-wide. */
  cancelOrder(creds: TradingCredentials, orderId: string, marketSlug: string, signal?: AbortSignal): Promise<CancelResult>;

  // ---- 1.13 (EXE-01): the only methods that can reach the venue's order API. Callable solely by ExecutionService. ----
  /** Read-only venue preview; creates nothing. */
  previewOrder(creds: TradingCredentials, req: OrderRequest, signal?: AbortSignal): Promise<OrderPreview>;
  /** Creates an order. A returned id is acceptance of the request, never a fill. Failures carry a `SubmitFailureClass`. */
  createOrder(creds: TradingCredentials, req: OrderRequest, signal?: AbortSignal): Promise<CreateOrderResult>;
  /** Classify a create failure: could an order exist at the venue despite the error? */
  classifySubmitFailure(err: unknown): SubmitFailureClass;
  getOrder(creds: TradingCredentials, orderId: string, signal?: AbortSignal): Promise<VenueOrder | undefined>;
  activities(creds: TradingCredentials, opts?: { cursor?: string; limit?: number; marketSlug?: string; signal?: AbortSignal }): Promise<ActivitiesPage>;
  /** Public settlement price of a market (undefined until settled). */
  settlement(marketSlug: string, signal?: AbortSignal): Promise<{ price: string } | undefined>;
  /** Authenticated private stream (orders, positions, balances). Resolves once connected; events arrive on the handlers. */
  openPrivateStream(creds: TradingCredentials, handlers: PrivateStreamHandlers): Promise<PrivateStreamHandle>;
}
