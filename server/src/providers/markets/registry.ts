/**
 * Prediction Ledger — market provider registry (1.6) with a test seam.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import type { MarketProvider, MarketProviderId } from "./types.js";
import { PolymarketProvider } from "./polymarket.js";
import { ManifoldProvider } from "./manifold.js";

export const MARKET_PROVIDER_IDS: MarketProviderId[] = ["polymarket", "manifold"];
export const isMarketProviderId = (x: string): x is MarketProviderId => (MARKET_PROVIDER_IDS as string[]).includes(x);

const overrides = new Map<MarketProviderId, MarketProvider>();
const singletons = new Map<MarketProviderId, MarketProvider>();

export function createMarketProvider(id: MarketProviderId): MarketProvider {
  const o = overrides.get(id);
  if (o) return o;
  let p = singletons.get(id);
  if (!p) {
    p = id === "manifold" ? new ManifoldProvider() : new PolymarketProvider();
    singletons.set(id, p);
  }
  return p;
}

/** Tests: substitute a fake provider (pass undefined to clear). */
export function setMarketProviderForTests(id: MarketProviderId, provider: MarketProvider | undefined): void {
  if (provider) overrides.set(id, provider);
  else overrides.delete(id);
}
