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
}
