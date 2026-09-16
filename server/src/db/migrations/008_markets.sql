-- Prediction Ledger — 1.6: prediction markets in the ledger (markets, snapshots, prediction↔market links).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.

CREATE TABLE markets (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,            -- 'polymarket'
  venue_id       TEXT NOT NULL,            -- Gamma market id
  condition_id   TEXT,
  slug           TEXT NOT NULL,
  url            TEXT NOT NULL,
  question       TEXT NOT NULL,
  description    TEXT,                     -- resolution rules as published
  event_id       TEXT,
  event_slug     TEXT,
  event_title    TEXT,
  outcomes_json  TEXT NOT NULL,            -- [{label, tokenId}]
  end_date       TEXT,
  start_date     TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  closed         INTEGER NOT NULL DEFAULT 0,
  restricted     INTEGER NOT NULL DEFAULT 0,
  resolved       INTEGER NOT NULL DEFAULT 0,
  resolved_outcome TEXT,
  tags_json      TEXT NOT NULL DEFAULT '[]',
  watched        INTEGER NOT NULL DEFAULT 0, -- refreshed on the schedule even without a link
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider, venue_id)
);
CREATE INDEX idx_markets_watched ON markets(watched);
CREATE INDEX idx_markets_end ON markets(end_date);

CREATE TABLE market_snapshots (
  id             TEXT PRIMARY KEY,
  market_id      TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  retrieved_at   TEXT NOT NULL,
  prices_json    TEXT NOT NULL,            -- [{label, price, bestBid, bestAsk}] in outcomes order
  liquidity      REAL,
  volume         REAL,
  volume_24h     REAL,
  spread         REAL,
  source         TEXT NOT NULL DEFAULT 'gamma' -- 'gamma' | 'clob' | 'history'
);
CREATE INDEX idx_snapshots_market ON market_snapshots(market_id, retrieved_at);

CREATE TABLE prediction_market_links (
  id             TEXT PRIMARY KEY,
  prediction_id  TEXT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  market_id      TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  side           TEXT,                     -- outcome label the prediction implies ('Yes', a team, …)
  score          REAL NOT NULL DEFAULT 0,  -- 0–1 match score
  relation       TEXT,                     -- 'same' | 'narrower' | 'broader' | 'different' | 'exact' | NULL
  rationale      TEXT,
  status         TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected')),
  matched_by     TEXT NOT NULL,            -- 'rule:sports' | 'rule:text' | 'model' | 'user'
  price_at_made  REAL,                     -- side price nearest the prediction's madeOn date, when known
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (prediction_id, market_id)
);
CREATE INDEX idx_links_prediction ON prediction_market_links(prediction_id, status);
CREATE INDEX idx_links_market ON prediction_market_links(market_id);
