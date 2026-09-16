-- Prediction Ledger — 1.12: immutable forecasts, trade decisions, risk reservations, intents, US paper execution (FOR-01…08, RSK-01…07).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
--
-- Additive only. Amounts, prices and quantities are decimal strings with the unit declared on the row; never REAL.
-- Decision-lineage tables carry no cascading foreign keys to predictions/videos/markets: deleting source content
-- must never delete a decision's rationale (spec §12) — the decision keeps its immutable input snapshot instead.

-- ---- markets: when the app first observed an official resolution (FOR-02/05 as-of replay) ----
ALTER TABLE markets ADD COLUMN resolved_at TEXT;
UPDATE markets SET resolved_at = updated_at WHERE resolved = 1 AND resolved_at IS NULL;

-- ---- verifications remember what they were before going stale (the trading cohort needs "was verified equivalent at claim time") ----
ALTER TABLE contract_verifications ADD COLUMN prior_status TEXT;

-- ---- legacy paper book keeps its method label (FOR-08 / F11) ----
ALTER TABLE paper_positions ADD COLUMN method TEXT NOT NULL DEFAULT 'legacy-snapshot-v1';

-- ---- policy: versioned pilot limits (RSK-02/03/07) ----
ALTER TABLE trading_policy ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'pilot-v1';
ALTER TABLE trading_policy ADD COLUMN limits_json TEXT;                 -- NULL = the defaults of policy_version
ALTER TABLE trading_policy ADD COLUMN budget_timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE trading_policy ADD COLUMN policy_hash TEXT;

-- ---- forecasts (FOR-01/03/04/06) ----
CREATE TABLE forecast_snapshots (
  id                 TEXT PRIMARY KEY,
  prediction_id      TEXT NOT NULL,
  market_id          TEXT NOT NULL,
  link_id            TEXT,
  verification_id    TEXT,
  strategy_version   TEXT NOT NULL,
  category           TEXT,
  as_of              TEXT NOT NULL,
  p_yes              TEXT NOT NULL,
  p_no               TEXT NOT NULL,
  prior_json         TEXT NOT NULL,           -- {p0, source, bookAt, bid, ask}
  status             TEXT NOT NULL CHECK (status IN ('experimental','qualified','expired','insufficient_data')),
  qualification_id   TEXT,
  inputs_json        TEXT NOT NULL,           -- versions of every input + estimator params
  formula_json       TEXT NOT NULL,
  exclusions_json    TEXT NOT NULL DEFAULT '[]',
  hash               TEXT NOT NULL,           -- sha256 over inputs, contributions and outputs
  expires_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_forecasts_prediction ON forecast_snapshots(prediction_id, created_at);
CREATE INDEX idx_forecasts_market ON forecast_snapshots(market_id, created_at);

CREATE TABLE forecast_contributions (
  id             TEXT PRIMARY KEY,
  forecast_id    TEXT NOT NULL REFERENCES forecast_snapshots(id) ON DELETE CASCADE,
  source_key     TEXT NOT NULL,
  cluster_key    TEXT NOT NULL,
  prediction_id  TEXT,
  stance         INTEGER NOT NULL CHECK (stance IN (1,-1)),
  claim_at       TEXT,
  n              INTEGER NOT NULL DEFAULT 0,
  mean_edge      TEXT,
  shrunk_edge    TEXT,
  weight         TEXT,
  age_days       REAL,
  selected       INTEGER NOT NULL DEFAULT 0,
  reason         TEXT NOT NULL,
  history_json   TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_forecast_contributions ON forecast_contributions(forecast_id);

-- Immutable: a forecast is never edited; a new one is written.
CREATE TRIGGER forecast_snapshots_no_update BEFORE UPDATE ON forecast_snapshots
BEGIN SELECT RAISE(ABORT, 'forecast_snapshots is immutable'); END;

-- ---- strategy qualification records (FOR-06/07). Fixture-sourced rows can never qualify a strategy. ----
CREATE TABLE strategy_qualifications (
  id                TEXT PRIMARY KEY,
  strategy_version  TEXT NOT NULL,
  category          TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('production','fixture')),
  events            INTEGER NOT NULL,
  brier             TEXT,
  baseline_brier    TEXT,
  qualified         INTEGER NOT NULL,
  report_json       TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_qualifications ON strategy_qualifications(strategy_version, category, created_at);

-- ---- decisions (RSK-01/07): every evaluation, skipped ones included ----
CREATE TABLE trade_decisions (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  clock_at           TEXT NOT NULL,           -- the controllable clock the decision was made with
  mode               TEXT NOT NULL CHECK (mode IN ('disabled','paper','manual_live','auto_live')),
  prediction_id      TEXT NOT NULL,
  market_id          TEXT NOT NULL,
  venue_market_id    TEXT NOT NULL,
  event_id           TEXT,
  link_id            TEXT,
  verification_id    TEXT,
  forecast_id        TEXT,
  policy_version     TEXT NOT NULL,
  policy_hash        TEXT,
  currency           TEXT NOT NULL,
  budget_timezone    TEXT NOT NULL,
  daily_bucket       TEXT NOT NULL,
  outcome            TEXT NOT NULL CHECK (outcome IN ('eligible','skipped','needs_review')),
  side               TEXT CHECK (side IN ('yes','no')),
  side_id            TEXT,
  side_label         TEXT,
  p_chosen           TEXT,
  quantity           TEXT,
  limit_cost         TEXT,
  wire_price         TEXT,
  fee_bound          TEXT,
  worst_cost         TEXT,
  net_edge           TEXT,
  estimated_ev       TEXT,
  bound_by           TEXT,
  gates_json         TEXT NOT NULL,
  reason_codes_json  TEXT NOT NULL,
  inputs_json        TEXT NOT NULL,           -- book, account ages, exposure, cutoff, fee — the immutable snapshot
  rationale_hash     TEXT NOT NULL,
  reservation_id     TEXT,
  intent_id          TEXT
);
CREATE INDEX idx_decisions_created ON trade_decisions(created_at);
CREATE INDEX idx_decisions_prediction ON trade_decisions(prediction_id, created_at);
CREATE INDEX idx_decisions_market ON trade_decisions(venue_market_id, created_at);
CREATE INDEX idx_decisions_bucket ON trade_decisions(daily_bucket, outcome);

-- ---- risk reservations (RSK-05): atomic check-and-insert inside one transaction ----
CREATE TABLE risk_reservations (
  id               TEXT PRIMARY KEY,
  decision_id      TEXT NOT NULL,
  account_key      TEXT NOT NULL,             -- 'paper' or the live binding id
  provider         TEXT NOT NULL,
  venue_market_id  TEXT NOT NULL,
  event_id         TEXT,
  amount           TEXT NOT NULL,             -- worst cost reserved
  filled_amount    TEXT NOT NULL DEFAULT '0', -- consumed by fills; never replenishes the daily allowance
  daily_bucket     TEXT NOT NULL,             -- fixed at reservation time (a timezone change never moves it)
  state            TEXT NOT NULL CHECK (state IN ('reserved','consumed','released','expired')),
  acknowledged     INTEGER NOT NULL DEFAULT 0, -- reflected in the venue's buying power (live, 1.13)
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_at      TEXT,
  note             TEXT
);
CREATE INDEX idx_reservations_account ON risk_reservations(account_key, state);
CREATE INDEX idx_reservations_bucket ON risk_reservations(account_key, daily_bucket);
CREATE INDEX idx_reservations_market ON risk_reservations(account_key, venue_market_id);

-- ---- intents (EXE-03 groundwork; paper only in 1.12) ----
CREATE TABLE trade_intents (
  id                 TEXT PRIMARY KEY,
  decision_id        TEXT NOT NULL,
  reservation_id     TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('paper','live')),
  account_key        TEXT NOT NULL,
  provider           TEXT NOT NULL,
  venue_market_id    TEXT NOT NULL,
  side               TEXT NOT NULL CHECK (side IN ('yes','no')),
  side_id            TEXT,
  quantity           TEXT NOT NULL,
  wire_price         TEXT NOT NULL,
  limit_cost         TEXT NOT NULL,
  time_in_force      TEXT NOT NULL DEFAULT 'IOC',
  state              TEXT NOT NULL CHECK (state IN ('prepared','reserved','submitting','acknowledged','filled','partially_filled','canceled','rejected_local','skipped','expired','submission_unknown')),
  payload_hash       TEXT NOT NULL,
  filled_quantity    TEXT NOT NULL DEFAULT '0',
  dispatch_marker_at TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_intents_decision ON trade_intents(decision_id);
CREATE INDEX idx_intents_state ON trade_intents(account_key, state);

-- One entry opportunity per account and contract, consumed at first dispatch, regardless of side, strategy or policy.
CREATE TABLE trade_opportunities (
  account_key      TEXT NOT NULL,
  provider         TEXT NOT NULL,
  venue_market_id  TEXT NOT NULL,
  intent_id        TEXT NOT NULL,
  consumed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (account_key, provider, venue_market_id)
);

-- ---- US paper execution (FOR-08): separate bankroll, book-depth fills, fees, IOC ----
CREATE TABLE paper_us_book (
  id              TEXT PRIMARY KEY CHECK (id = 'default'),
  method          TEXT NOT NULL DEFAULT 'us-ioc-v1',
  currency        TEXT NOT NULL DEFAULT 'USD',
  bankroll_start  TEXT NOT NULL DEFAULT '100',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reset_at        TEXT
);
INSERT INTO paper_us_book (id) VALUES ('default');

CREATE TABLE paper_us_positions (
  id               TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL,
  decision_id      TEXT NOT NULL,
  market_id        TEXT NOT NULL,
  venue_market_id  TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('yes','no')),
  side_id          TEXT,
  quantity         TEXT NOT NULL,
  avg_cost         TEXT NOT NULL,
  cost_total       TEXT NOT NULL,
  fees             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('open','settled','void')) DEFAULT 'open',
  opened_at        TEXT NOT NULL,
  settled_at       TEXT,
  outcome          TEXT CHECK (outcome IN ('win','loss','void')),
  pnl              TEXT,
  method           TEXT NOT NULL DEFAULT 'us-ioc-v1'
);
CREATE INDEX idx_paper_us_status ON paper_us_positions(status, opened_at);
CREATE INDEX idx_paper_us_market ON paper_us_positions(venue_market_id);

CREATE TABLE paper_us_fills (
  id           TEXT PRIMARY KEY,
  intent_id    TEXT NOT NULL,
  position_id  TEXT,
  seq          INTEGER NOT NULL,
  quantity     TEXT NOT NULL,
  chosen_cost  TEXT NOT NULL,
  yes_price    TEXT NOT NULL,
  fee          TEXT NOT NULL,
  at           TEXT NOT NULL
);
CREATE INDEX idx_paper_us_fills_intent ON paper_us_fills(intent_id, seq);

-- ---- settlement events (EXE-08 groundwork): paper settlements come from the venue's published resolution ----
CREATE TABLE settlement_events (
  id               TEXT PRIMARY KEY,
  market_id        TEXT NOT NULL,
  venue_market_id  TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('resolved','void','correction','external_exit')),
  outcome          TEXT,
  source           TEXT NOT NULL,             -- 'venue_market_status' (paper) | 'account_activity' (live, 1.13)
  observed_at      TEXT NOT NULL,
  details_json     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_settlement_market ON settlement_events(venue_market_id, observed_at);
