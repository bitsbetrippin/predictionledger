-- Prediction Ledger — 1.7: price-at-made provenance for market links.
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.

ALTER TABLE prediction_market_links ADD COLUMN price_at_made_at TEXT;      -- instant of the price point used
ALTER TABLE prediction_market_links ADD COLUMN price_at_made_source TEXT;  -- 'history' | 'snapshot'
