/**
 * Prediction Ledger — trading adapter registry (1.10) with a test seam.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * The production factory constructs the adapter with its fixed hosts and nothing else — no setting,
 * environment variable or request field can point it elsewhere (ACC-04). Tests substitute a fake.
 */

import type { TradingVenueId } from "@prediction-ledger/shared";
import { PolymarketUsTradingAdapter } from "./polymarketUs.js";
import type { TradingAdapter } from "./types.js";

let override: TradingAdapter | undefined;
let singleton: TradingAdapter | undefined;

export function createTradingAdapter(venue: TradingVenueId = "polymarket_us"): TradingAdapter {
  if (override) return override;
  if (venue !== "polymarket_us") throw new Error(`Unknown trading venue ${venue as string}`);
  singleton ??= new PolymarketUsTradingAdapter();
  return singleton;
}

/** Tests: substitute a fake adapter (pass undefined to clear). */
export function setTradingAdapterForTests(adapter: TradingAdapter | undefined): void {
  override = adapter;
}
