-- Prediction Ledger — 1.9: paper-trading ledger (hypothetical positions only; the app never places orders).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.

CREATE TABLE paper_positions (
  id             TEXT PRIMARY KEY,
  market_id      TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  side           TEXT NOT NULL,
  opened_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  opened_price   REAL NOT NULL,            -- probability 0–1 paid per share
  stake          REAL NOT NULL,            -- quote currency committed
  shares         REAL NOT NULL,            -- stake / opened_price; pays 1 per share if the side wins
  source         TEXT NOT NULL CHECK (source IN ('manual','signal','auto')),
  edge_at_open   REAL,                     -- signal edge when opened
  estimate_at_open REAL,                   -- creators' estimate when opened
  confidence_at_open TEXT,                 -- signal label when opened
  prediction_ids_json TEXT NOT NULL DEFAULT '[]',
  notes          TEXT,
  status         TEXT NOT NULL CHECK (status IN ('open','closed')) DEFAULT 'open',
  closed_at      TEXT,
  closed_price   REAL,                     -- 1 / 0 on resolution, or the mark at a manual close
  close_reason   TEXT CHECK (close_reason IN ('manual','resolved','ledger')),
  realized_pnl   REAL,
  last_mark_price REAL,
  last_marked_at TEXT
);
CREATE INDEX idx_paper_status ON paper_positions(status, opened_at);
CREATE INDEX idx_paper_market ON paper_positions(market_id);

CREATE TABLE paper_marks (
  id             TEXT PRIMARY KEY,
  position_id    TEXT NOT NULL REFERENCES paper_positions(id) ON DELETE CASCADE,
  marked_at      TEXT NOT NULL,
  price          REAL NOT NULL,
  unrealized_pnl REAL NOT NULL
);
CREATE INDEX idx_paper_marks_position ON paper_marks(position_id, marked_at);
