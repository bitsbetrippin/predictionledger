-- Prediction Ledger — 1.10: Polymarket US account connection foundation (ACC-01…06, OPS-01/02).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
--
-- Additive only. No plaintext credential is stored in any of these tables: key material lives in the
-- `secrets` table (AES-256-GCM) under the protected `trading.` namespace. Amounts are decimal strings
-- with their unit declared. Nothing here can place an order; the tables that carry intents, orders and
-- reservations arrive with 1.12/1.13 after their gates.

-- One row per credential/account binding. The venue exposes no verified account identity (spec §14.1,
-- verified 2026-09-16), so the binding is local: an app-generated id plus a fingerprint of the credential's
-- public key. Rows are retained forever; disconnecting changes `state`, it never deletes history.
CREATE TABLE trading_accounts (
  id                     TEXT PRIMARY KEY,                       -- local binding id (uuid)
  venue                  TEXT NOT NULL CHECK (venue IN ('polymarket_us')),
  state                  TEXT NOT NULL CHECK (state IN ('connected','disconnected','needs_rebind','superseded')),
  identity_kind          TEXT NOT NULL DEFAULT 'local_binding' CHECK (identity_kind IN ('local_binding','venue_verified')),
  external_identity      TEXT,                                   -- NULL unless a venue ever exposes one
  credential_fingerprint TEXT,                                   -- sha256(ed25519 public key) hex prefix; not secret
  key_id_hint            TEXT,                                   -- masked, e.g. "…4f2a"
  secret_hint            TEXT,
  continuity             TEXT NOT NULL CHECK (continuity IN ('first','same_credential','user_asserted','unverified')),
  reconcile_required     INTEGER NOT NULL DEFAULT 0,
  superseded_by          TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_validated_at      TEXT,
  last_validation_error  TEXT,
  last_sync_at           TEXT,
  disconnected_at        TEXT
);
-- At most one connected binding per venue.
CREATE UNIQUE INDEX idx_trading_accounts_connected ON trading_accounts(venue) WHERE state = 'connected';
CREATE INDEX idx_trading_accounts_created ON trading_accounts(created_at);

-- Read-only account snapshots (balances, positions, open orders) as the venue reported them.
CREATE TABLE trading_account_syncs (
  id               TEXT PRIMARY KEY,
  binding_id       TEXT NOT NULL REFERENCES trading_accounts(id),
  at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ok               INTEGER NOT NULL,
  error            TEXT,                                          -- redacted
  balances_json    TEXT NOT NULL DEFAULT '[]',
  positions_json   TEXT NOT NULL DEFAULT '[]',
  open_orders_json TEXT NOT NULL DEFAULT '[]',
  complete         INTEGER NOT NULL DEFAULT 0                     -- every page of positions/orders was read
);
CREATE INDEX idx_trading_syncs_binding ON trading_account_syncs(binding_id, at);

-- Append-only, secret-free audit trail of credential, policy and operational transitions.
CREATE TABLE trading_audit_events (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  binding_id   TEXT,
  kind         TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_trading_audit_at ON trading_audit_events(at);
CREATE TRIGGER trading_audit_events_no_update BEFORE UPDATE ON trading_audit_events
BEGIN SELECT RAISE(ABORT, 'trading_audit_events is append-only'); END;
CREATE TRIGGER trading_audit_events_no_delete BEFORE DELETE ON trading_audit_events
BEGIN SELECT RAISE(ABORT, 'trading_audit_events is append-only'); END;

-- Trading mode and live authorization live here, NOT in the generic settings document, so a settings save
-- can never arm trading (ACC-05). Default: paper, no live authorization.
CREATE TABLE trading_policy (
  id                      TEXT PRIMARY KEY CHECK (id = 'default'),
  mode                    TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('disabled','paper','manual_live','auto_live')),
  live_authorized_at      TEXT,
  live_authorization_hash TEXT,
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO trading_policy (id, mode) VALUES ('default', 'paper');

-- Venue contract constraints for Polymarket US markets (tick, min quantity, fee coefficient, durable side ids,
-- times). NULL for every existing international/Manifold row; those records are untouched.
ALTER TABLE markets ADD COLUMN constraints_json TEXT;
