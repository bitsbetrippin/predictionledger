-- Prediction Ledger — 1.8: watch-rule alerts and playlist/channel imports.
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.

CREATE TABLE alerts (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('market_move','divergence','resolving_soon')),
  market_id      TEXT REFERENCES markets(id) ON DELETE CASCADE,
  side           TEXT,
  prediction_id  TEXT REFERENCES predictions(id) ON DELETE CASCADE,
  message        TEXT NOT NULL,
  value          REAL,                     -- the measured quantity (pts moved, pts of divergence, days to resolution)
  threshold      REAL,                     -- the rule threshold at the time
  dedupe_key     TEXT NOT NULL UNIQUE,     -- one alert per rule/subject/period
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  seen_at        TEXT,
  dismissed_at   TEXT
);
CREATE INDEX idx_alerts_open ON alerts(dismissed_at, created_at);

-- Where a video came from when imported in bulk (playlist / channel URL), for grouping and re-import.
ALTER TABLE videos ADD COLUMN source_list TEXT;
