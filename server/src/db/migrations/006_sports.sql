-- Prediction Ledger — migration 006: sports picks (Release 1.2).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.

ALTER TABLE predictions ADD COLUMN kind TEXT NOT NULL DEFAULT 'general';  -- 'general' | 'sports_pick'
ALTER TABLE predictions ADD COLUMN sports_json TEXT;                       -- SportsPick JSON for kind = 'sports_pick'
CREATE INDEX idx_predictions_kind ON predictions(kind);
