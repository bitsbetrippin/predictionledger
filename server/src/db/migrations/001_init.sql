-- Prediction Ledger — migration 001: settings, secrets, jobs.
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
--
-- Release 0.1 only needs configuration and the durable job table. Content tables
-- (videos, transcript_segments, predictions, ...) arrive in their own migrations
-- as each release lands; the full target schema is documented in docs/ARCHITECTURE.md §5.

-- Non-secret settings as a single JSON document per key (currently only "app").
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Secrets are encrypted with AES-256-GCM using the key in <dataDir>/secret.key.
-- The plaintext never touches this table, logs, exports, or the browser.
CREATE TABLE secrets (
  name        TEXT PRIMARY KEY,          -- e.g. "llm.anthropic.apiKey"
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,
  auth_tag    BLOB NOT NULL,
  hint        TEXT NOT NULL,             -- masked form for display, e.g. "sk-ant-…4f2a"
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Durable background jobs. The in-process worker claims rows atomically; on restart
-- any job left in "running" with a stale heartbeat is returned to "queued".
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,        -- UUID
  kind          TEXT NOT NULL,           -- see JobKind in @prediction-ledger/shared
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','completed','failed','cancelled')),
  subject_type  TEXT,                    -- 'video' | 'prediction' | ...
  subject_id    TEXT,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  result_json   TEXT,
  progress      INTEGER NOT NULL DEFAULT 0,
  stage         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  error         TEXT,
  dedupe_key    TEXT,                    -- prevents duplicate work for the same subject+kind
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at    TEXT,
  heartbeat_at  TEXT,
  finished_at   TEXT
);

CREATE INDEX idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX idx_jobs_subject ON jobs(subject_type, subject_id);
CREATE UNIQUE INDEX idx_jobs_dedupe_active ON jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');
