-- Prediction Ledger — 1.13: manual-live execution — previews, venue orders, executions, holds, dispatch lease (EXE-01…08, OPS-03).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
--
-- Additive except for one in-place rebuild of trade_intents (SQLite cannot widen a CHECK constraint): every row
-- and every column value is carried over; the rebuild only adds the 'rejected' state and the live lineage columns.

-- ---- intents: widen the state set and add live lineage ----
CREATE TABLE trade_intents_new (
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
  state              TEXT NOT NULL CHECK (state IN ('prepared','reserved','submitting','acknowledged','filled','partially_filled','canceled','rejected','rejected_local','skipped','expired','submission_unknown')),
  payload_hash       TEXT NOT NULL,
  filled_quantity    TEXT NOT NULL DEFAULT '0',
  dispatch_marker_at TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  binding_id         TEXT,
  venue_order_id     TEXT,
  preview_id         TEXT,
  decision_hash      TEXT,
  submitted_at       TEXT,
  acknowledged_at    TEXT,
  unknown_reason     TEXT,
  last_error         TEXT,
  market_slug        TEXT
);
INSERT INTO trade_intents_new (id, decision_id, reservation_id, mode, account_key, provider, venue_market_id, side, side_id, quantity, wire_price, limit_cost, time_in_force, state, payload_hash, filled_quantity, dispatch_marker_at, created_at, updated_at)
  SELECT id, decision_id, reservation_id, mode, account_key, provider, venue_market_id, side, side_id, quantity, wire_price, limit_cost, time_in_force, state, payload_hash, filled_quantity, dispatch_marker_at, created_at, updated_at FROM trade_intents;
DROP TABLE trade_intents;
ALTER TABLE trade_intents_new RENAME TO trade_intents;
CREATE INDEX idx_intents_decision ON trade_intents(decision_id);
CREATE INDEX idx_intents_state ON trade_intents(account_key, state);
CREATE INDEX idx_intents_order ON trade_intents(venue_order_id);

-- ---- order previews (EXE-02): read-only, short-lived, bound to one immutable decision hash ----
CREATE TABLE order_previews (
  id               TEXT PRIMARY KEY,
  decision_id      TEXT NOT NULL,
  decision_hash    TEXT NOT NULL,
  binding_id       TEXT NOT NULL,
  request_json     TEXT NOT NULL,
  venue_json       TEXT,
  display_json     TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  consumed_at      TEXT,
  consumed_by      TEXT CHECK (consumed_by IN ('submit','stale','expired'))
);
CREATE INDEX idx_previews_decision ON order_previews(decision_id, created_at);

-- ---- venue orders (EXE-06): ours and external, keyed by the venue's id ----
CREATE TABLE venue_orders (
  id                   TEXT PRIMARY KEY,           -- exchange-assigned order id
  binding_id           TEXT NOT NULL,
  intent_id            TEXT,                       -- NULL = not placed by this app (external)
  external             INTEGER NOT NULL DEFAULT 0,
  market_slug          TEXT NOT NULL,
  venue_market_id      TEXT,
  side                 TEXT CHECK (side IN ('yes','no')),
  intent_raw           TEXT,
  state_raw            TEXT,
  state                TEXT NOT NULL CHECK (state IN ('pending','open','partial','filled','cancel_pending','canceled','expired','rejected','unknown')),
  quantity             TEXT,
  filled_quantity      TEXT NOT NULL DEFAULT '0',
  leaves_quantity      TEXT,
  yes_price            TEXT,
  avg_price            TEXT,
  fees                 TEXT,
  venue_created_at     TEXT,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  first_seen_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cancel_requested_at  TEXT,
  reject_reason        TEXT,
  raw_json             TEXT
);
CREATE INDEX idx_venue_orders_binding ON venue_orders(binding_id, state);
CREATE INDEX idx_venue_orders_intent ON venue_orders(intent_id);
CREATE INDEX idx_venue_orders_market ON venue_orders(market_slug);

-- ---- executions (EXE-06): unique by execution id, deduplicated by trade id across stream / REST / activities ----
CREATE TABLE executions (
  id            TEXT PRIMARY KEY,                  -- exchange execution id, or 'trade:<tradeId>' when only the trade is known
  order_id      TEXT NOT NULL,
  intent_id     TEXT,
  trade_id      TEXT,
  type          TEXT NOT NULL CHECK (type IN ('new','partial_fill','fill','canceled','rejected','expired','replace','done_for_day','unknown')),
  quantity      TEXT,
  yes_price     TEXT,
  chosen_cost   TEXT,
  fee           TEXT,
  at            TEXT,
  source        TEXT NOT NULL CHECK (source IN ('create_response','stream','rest','activity')),
  note          TEXT,
  received_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  raw_json      TEXT
);
CREATE UNIQUE INDEX idx_executions_trade ON executions(trade_id) WHERE trade_id IS NOT NULL;
CREATE INDEX idx_executions_order ON executions(order_id, at);
CREATE TRIGGER executions_no_update BEFORE UPDATE ON executions
BEGIN SELECT RAISE(ABORT, 'executions are append-only'); END;

-- ---- reconciliation holds (EXE-04/05/07): anything that pauses new orders until an owner resolves it ----
CREATE TABLE reconciliation_holds (
  id           TEXT PRIMARY KEY,
  binding_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('submission_unknown','discrepancy','failed_cancel','stale_sync','stream_gap')),
  subject      TEXT,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  opened_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at  TEXT,
  resolution   TEXT
);
CREATE INDEX idx_holds_open ON reconciliation_holds(binding_id, resolved_at);

-- ---- authoritative position snapshots from the venue (EXE-07) ----
CREATE TABLE position_snapshots (
  id            TEXT PRIMARY KEY,
  binding_id    TEXT NOT NULL,
  market_slug   TEXT NOT NULL,
  net_quantity  TEXT NOT NULL,
  cost          TEXT,
  realized      TEXT,
  source        TEXT NOT NULL CHECK (source IN ('rest','stream')),
  at            TEXT NOT NULL
);
CREATE INDEX idx_position_snapshots ON position_snapshots(binding_id, market_slug, at);

-- ---- settlement events gain live lineage (EXE-08) ----
ALTER TABLE settlement_events ADD COLUMN binding_id TEXT;
ALTER TABLE settlement_events ADD COLUMN intent_id TEXT;
ALTER TABLE settlement_events ADD COLUMN amount TEXT;
ALTER TABLE settlement_events ADD COLUMN activity_id TEXT;
CREATE UNIQUE INDEX idx_settlement_activity ON settlement_events(activity_id) WHERE activity_id IS NOT NULL;

-- ---- one dispatcher per data directory (OPS-03) ----
CREATE TABLE dispatch_leases (
  id            TEXT PRIMARY KEY CHECK (id = 'default'),
  holder        TEXT,
  acquired_at   TEXT,
  expires_at    TEXT,
  heartbeat_at  TEXT
);
INSERT INTO dispatch_leases (id) VALUES ('default');

-- ---- account-level dispatch pause (EXE-04): set while an unknown submission or a discrepancy is unresolved ----
ALTER TABLE trading_accounts ADD COLUMN dispatch_paused_reason TEXT;
