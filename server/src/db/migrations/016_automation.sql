-- Prediction Ledger — 1.14: automatic execution behind arming, pause / emergency stop, alerts, scheduler runs, ledger indexes (AUTO-01…05, DASH, OPS-04).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
--
-- Additive only: new nullable columns, new tables, new indexes. Nothing is rewritten; 1.13 data is untouched.

-- ---- policy: the authorization an owner granted for automation, an owner pause, and the scheduler budgets (hashed) ----
ALTER TABLE trading_policy ADD COLUMN authorized_policy_hash TEXT;
ALTER TABLE trading_policy ADD COLUMN authorized_strategy_version TEXT;
ALTER TABLE trading_policy ADD COLUMN authorized_category TEXT;
ALTER TABLE trading_policy ADD COLUMN pause_reason TEXT;
ALTER TABLE trading_policy ADD COLUMN paused_at TEXT;
ALTER TABLE trading_policy ADD COLUMN automation_json TEXT;

-- ---- account: circuit breaker state (AUTO-05) ----
ALTER TABLE trading_accounts ADD COLUMN breaker_json TEXT;

-- ---- local alerts, one row per incident (AUTO-05) ----
CREATE TABLE trading_alerts (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  incident_key     TEXT NOT NULL UNIQUE,
  subject          TEXT,
  message          TEXT NOT NULL,
  details_json     TEXT NOT NULL DEFAULT '{}',
  first_at         TEXT NOT NULL,
  last_at          TEXT NOT NULL,
  count            INTEGER NOT NULL DEFAULT 1,
  acknowledged_at  TEXT
);
CREATE INDEX idx_trading_alerts_open ON trading_alerts(acknowledged_at, last_at);

-- ---- scheduler runs and every candidate's outcome (AUTO-02/05, OPS-04 correlation ids) ----
CREATE TABLE automation_runs (
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  holder        TEXT NOT NULL,
  mode          TEXT NOT NULL,
  policy_hash   TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('completed','skipped','failed')),
  reason        TEXT,
  candidates    INTEGER NOT NULL DEFAULT 0,
  evaluated     INTEGER NOT NULL DEFAULT 0,
  ordered       INTEGER NOT NULL DEFAULT 0,
  skipped_json  TEXT NOT NULL DEFAULT '{}',
  notes_json    TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_automation_runs_started ON automation_runs(started_at);

CREATE TABLE automation_candidates (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  prediction_id  TEXT NOT NULL,
  link_id        TEXT,
  market_id      TEXT,
  source_key     TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ordered','evaluated','skipped','queued_work')),
  reason         TEXT NOT NULL,
  decision_id    TEXT,
  intent_id      TEXT,
  at             TEXT NOT NULL
);
CREATE INDEX idx_automation_candidates_run ON automation_candidates(run_id);
CREATE INDEX idx_automation_candidates_prediction ON automation_candidates(prediction_id, at);

-- ---- ledger performance (OPS-04): the Trades page filters by clock, prediction and market ----
CREATE INDEX IF NOT EXISTS idx_trade_decisions_clock ON trade_decisions(clock_at);
CREATE INDEX IF NOT EXISTS idx_trade_decisions_prediction ON trade_decisions(prediction_id, clock_at);
CREATE INDEX IF NOT EXISTS idx_trade_decisions_market ON trade_decisions(market_id, clock_at);
CREATE INDEX IF NOT EXISTS idx_settlement_intent ON settlement_events(intent_id);
CREATE INDEX IF NOT EXISTS idx_trading_audit_at ON trading_audit_events(at);
