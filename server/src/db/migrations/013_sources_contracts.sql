-- Prediction Ledger — 1.11: source subscriptions, provenance, evidence immutability, contract verification (SRC-01…06, MAT-01…06).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
--
-- Additive only. Existing rows are backfilled where the meaning is exact (first_seen = the time the app
-- already recorded) and left NULL where it is not known (a hash we never computed stays unknown).

-- ---- SRC-02 provenance on videos and predictions ----
ALTER TABLE videos ADD COLUMN channel_id TEXT;                -- venue channel id when exposed (yt-dlp `channel_id`)
ALTER TABLE videos ADD COLUMN published_precision TEXT;       -- 'datetime' | 'date' | 'unknown'
ALTER TABLE videos ADD COLUMN first_seen_at TEXT;             -- when the app first learned the video existed (poll or import)
ALTER TABLE videos ADD COLUMN transcript_hash TEXT;           -- sha256 over original segment texts (never over corrections)
ALTER TABLE videos ADD COLUMN subscription_id TEXT;           -- the subscription that discovered it, if any
UPDATE videos SET first_seen_at = imported_at WHERE first_seen_at IS NULL;
UPDATE videos SET published_precision = CASE WHEN published_at IS NULL THEN 'unknown' WHEN length(published_at) > 10 THEN 'datetime' ELSE 'date' END WHERE published_precision IS NULL;

ALTER TABLE predictions ADD COLUMN quote_hash TEXT;           -- sha256(quote_exact)
ALTER TABLE predictions ADD COLUMN transcript_hash TEXT;      -- transcript the quote was located in
ALTER TABLE predictions ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 1;  -- extraction pass number over the video

-- ---- SRC-04/06 sources: what the app knew when, and immutability status ----
ALTER TABLE sources ADD COLUMN first_seen_at TEXT;
ALTER TABLE sources ADD COLUMN status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','withdrawn','missing'));
ALTER TABLE sources ADD COLUMN status_changed_at TEXT;
ALTER TABLE sources ADD COLUMN status_note TEXT;
ALTER TABLE sources ADD COLUMN independence_group TEXT;       -- same group = one voice (publisher / near-duplicate text)
ALTER TABLE sources ADD COLUMN last_checked_at TEXT;
ALTER TABLE sources ADD COLUMN last_http_status INTEGER;
UPDATE sources SET first_seen_at = retrieved_at WHERE first_seen_at IS NULL;
CREATE INDEX idx_sources_group ON sources(independence_group);

-- ---- SRC-04 research runs: prospective vs retrospective ----
ALTER TABLE research_runs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'verdict' CHECK (purpose IN ('verdict','forecast'));
ALTER TABLE research_runs ADD COLUMN cutoff_at TEXT;          -- instant; NULL = cutoff_date end of day (UTC)

-- ---- SRC-01 subscriptions ----
CREATE TABLE source_subscriptions (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('channel','playlist')),
  url                  TEXT NOT NULL,                          -- canonical listing URL
  title                TEXT,
  enabled              INTEGER NOT NULL DEFAULT 1,
  poll_interval_hours  REAL NOT NULL DEFAULT 24,
  lookback_days        INTEGER NOT NULL DEFAULT 30,
  max_videos_per_run   INTEGER NOT NULL DEFAULT 5,
  auto_extract         INTEGER NOT NULL DEFAULT 1,
  allowlist_json       TEXT NOT NULL DEFAULT '[]',             -- title keywords; empty = everything
  research_budget_json TEXT,                                   -- {maxSearches?, maxSources?}
  last_run_at          TEXT,
  next_run_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (url)
);

CREATE TABLE subscription_runs (
  id               TEXT PRIMARY KEY,
  subscription_id  TEXT NOT NULL REFERENCES source_subscriptions(id) ON DELETE CASCADE,
  at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  listed           INTEGER NOT NULL DEFAULT 0,
  queued           INTEGER NOT NULL DEFAULT 0,
  already_known    INTEGER NOT NULL DEFAULT 0,
  skipped_lookback INTEGER NOT NULL DEFAULT 0,
  skipped_allowlist INTEGER NOT NULL DEFAULT 0,
  skipped_budget   INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  queued_video_ids_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_subscription_runs ON subscription_runs(subscription_id, at);

-- ---- MAT-02…06 contract verification (immutable versions; a new check is a new row) ----
CREATE TABLE contract_verifications (
  id                  TEXT PRIMARY KEY,
  link_id             TEXT NOT NULL REFERENCES prediction_market_links(id) ON DELETE CASCADE,
  prediction_id       TEXT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  market_id           TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('unverified','incomplete','incompatible','research_only','verified_equivalent','stale')),
  fields_json         TEXT NOT NULL,                           -- ContractField[]
  side_id             TEXT,
  side_label          TEXT,
  side_basis          TEXT,
  rules_hash          TEXT,
  cutoff_at           TEXT,
  cutoff_basis        TEXT,
  cutoff_unknown      INTEGER NOT NULL DEFAULT 1,
  quote_hash          TEXT,
  prediction_revision INTEGER NOT NULL DEFAULT 0,
  facts_json          TEXT NOT NULL DEFAULT '{}',
  reviewer            TEXT NOT NULL CHECK (reviewer IN ('app','user')),
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  stale_at            TEXT,
  stale_reasons_json  TEXT,
  UNIQUE (link_id, version)
);
CREATE INDEX idx_verifications_link ON contract_verifications(link_id, version);

-- Legacy accepted links start execution-unverified (MAT-03).
ALTER TABLE prediction_market_links ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE prediction_market_links ADD COLUMN verification_id TEXT;
