/**
 * Prediction Ledger — MarketProvider interface (1.5): read-only access to a prediction market.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * A market provider answers "what is the market's current belief about X?" — it never places
 * orders. Prices are probabilities (0–1) for each outcome; liquidity and volume are in the venue's
 * quote currency (USDC for Polymarket). Everything here is a snapshot at `retrievedAt`.
 */

import type { MarketContractConstraints, MarketProviderId } from "@prediction-ledger/shared";

export type { MarketProviderId };

export interface MarketOutcome {
  /** Outcome label as the venue prints it ("Yes" / "No", or a team name). */
  label: string;
  /** Venue-specific tradable id (Polymarket: CLOB token id) — needed for books and price history. */
  tokenId?: string;
  /** Last/mid price expressed as probability 0–1. */
  price?: number;
  bestBid?: number;
  bestAsk?: number;
}

export interface MarketSummary {
  provider: MarketProviderId;
  /** Venue market id (Polymarket Gamma `id`). */
  id: string;
  /** Venue condition/question id used by the trading layer (Polymarket `conditionId`). */
  conditionId?: string;
  slug: string;
  url: string;
  question: string;
  /** Resolution rules as published — the text that decides what "Yes" means. */
  description?: string;
  /** Grouping (Polymarket event): several markets under one headline, e.g. a game's ML/spread/total. */
  event?: { id: string; slug: string; title: string };
  outcomes: MarketOutcome[];
  /** Venue-reported liquidity in quote currency. */
  liquidity?: number;
  volume?: number;
  volume24h?: number;
  /** Market end/resolution deadline as the venue states it (ISO). */
  endDate?: string;
  startDate?: string;
  active: boolean;
  closed: boolean;
  /** Venue flags the market as geo-restricted for trading (data is still readable). */
  restricted?: boolean;
  /** Resolution state when the venue exposes it. */
  resolved?: boolean;
  resolvedOutcome?: string;
  tags?: string[];
  retrievedAt: string;
  /** 1.10 — venue contract constraints (Polymarket US only). */
  constraints?: MarketContractConstraints;
}

export interface OrderBookLevel { price: number; size: number }
export interface OrderBookSnapshot {
  provider: MarketProviderId;
  tokenId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  midpoint?: number;
  retrievedAt: string;
}

export interface PricePoint {
  /** ISO timestamp. */
  t: string;
  /** Probability 0–1. */
  p: number;
}

export interface MarketProvider {
  readonly id: MarketProviderId;
  /** Free-text search across the venue's markets/events. */
  search(query: string, opts?: { limit?: number; activeOnly?: boolean; signal?: AbortSignal }): Promise<MarketSummary[]>;
  /** One market by venue id or slug. */
  get(idOrSlug: string, signal?: AbortSignal): Promise<MarketSummary | undefined>;
  /** Markets under a tag (e.g. "nfl"), newest first. */
  list(opts: { tag?: string; limit?: number; offset?: number; activeOnly?: boolean; signal?: AbortSignal }): Promise<MarketSummary[]>;
  /** Live order book + midpoint for one outcome token. */
  book(tokenId: string, signal?: AbortSignal): Promise<OrderBookSnapshot>;
  /** Historical prices for one outcome token between two ISO instants (1.7). */
  priceHistory(tokenId: string, opts: { from: string; to: string; fidelityMinutes?: number; signal?: AbortSignal }): Promise<PricePoint[]>;
}

export class MarketApiError extends Error {
  constructor(public readonly provider: MarketProviderId, public readonly status: number, message: string) {
    super(`${provider}: HTTP ${status} — ${message.slice(0, 300)}`);
  }
}
