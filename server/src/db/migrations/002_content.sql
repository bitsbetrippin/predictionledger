-- Prediction Ledger — migration 002: content tables for Release 0.2 (Milestone 1).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
--
-- Videos, transcript segments, predictions (+ components, revisions), validation plans,
-- and user prompt-template overrides. Research/evidence/assessment tables arrive in 003.
-- Design rules (docs/ARCHITECTURE.md §5.2): original text is immutable; user edits are
-- revisions; every generated artifact records provider, model, template version, and time.

CREATE TABLE videos (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  source_kind    TEXT NOT NULL CHECK (source_kind IN ('local','youtube','transcript')),
  source_ref     TEXT,                    -- file hash, URL, or original transcript filename
  duration_s     REAL,
  published_at   TEXT,                    -- ISO date if known; NULL otherwise (never invented)
  language       TEXT,
  imported_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status         TEXT NOT NULL DEFAULT 'ready'
                 CHECK (status IN ('importing','transcribing','ready','extracting','failed')),
  notes          TEXT
);

CREATE TABLE transcript_segments (
  id             TEXT PRIMARY KEY,
  video_id       TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  start_s        REAL NOT NULL,
  end_s          REAL NOT NULL,
  text_original  TEXT NOT NULL,           -- immutable
  text_corrected TEXT,                    -- user correction, NULL when none
  speaker        TEXT,
  engine         TEXT NOT NULL,           -- 'import:srt' | 'import:vtt' | 'import:txt' | 'import:json' | later: 'local-whisper' ...
  chunk_id       TEXT
);
CREATE UNIQUE INDEX idx_segments_video_seq ON transcript_segments(video_id, seq);
CREATE INDEX idx_segments_video_start ON transcript_segments(video_id, start_s);

CREATE TABLE predictions (
  id                     TEXT PRIMARY KEY,
  video_id               TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  quote_exact            TEXT NOT NULL,   -- immutable, verbatim from transcript
  context_before         TEXT,
  context_after          TEXT,
  start_s                REAL,
  end_s                  REAL,
  speaker                TEXT,            -- NULL = unknown
  normalized_statement   TEXT NOT NULL,
  entities_json          TEXT NOT NULL DEFAULT '[]',
  topic                  TEXT,
  geography              TEXT,            -- NULL = unstated (never invented)
  scope                  TEXT,
  conditions_json        TEXT NOT NULL DEFAULT '[]',
  thresholds_json        TEXT NOT NULL DEFAULT '[]',
  modality               TEXT,            -- 'will' | 'likely' | 'might' | 'could' | 'expects' | ...
  made_on_date           TEXT,            -- ISO date the statement was made, if known
  made_on_basis          TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (made_on_basis IN ('statement','publication','user','unknown')),
  time_expression        TEXT,            -- original wording, e.g. "within two years"
  deadline_date          TEXT,            -- resolved ISO date or NULL
  deadline_basis         TEXT,            -- how it was resolved: 'rule:relative' | 'rule:absolute' | 'model' | 'user' | NULL
  ambiguities_json       TEXT NOT NULL DEFAULT '[]',
  extraction_confidence  REAL,
  user_status            TEXT NOT NULL DEFAULT 'pending'
                         CHECK (user_status IN ('pending','accepted','dismissed','merged')),
  merged_into_id         TEXT REFERENCES predictions(id) ON DELETE SET NULL,
  duplicate_of_id        TEXT REFERENCES predictions(id) ON DELETE SET NULL,
  occurrences_json       TEXT NOT NULL DEFAULT '[]',   -- [{start_s,end_s,window_id}] every place it was said
  extraction_provider    TEXT,
  extraction_model       TEXT,
  extraction_template    TEXT,            -- e.g. 'extraction.v1'
  extraction_job_id      TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_predictions_video_status ON predictions(video_id, user_status);
CREATE INDEX idx_predictions_deadline ON predictions(deadline_date);
CREATE INDEX idx_predictions_topic ON predictions(topic);

CREATE TABLE prediction_components (
  id             TEXT PRIMARY KEY,
  prediction_id  TEXT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('future_claim','premise','causal_link')),
  statement      TEXT NOT NULL,
  deadline_date  TEXT,
  notes          TEXT
);
CREATE INDEX idx_components_prediction ON prediction_components(prediction_id, seq);

-- Every user edit to a prediction is a revision; the row above always reflects the latest.
CREATE TABLE prediction_revisions (
  id             TEXT PRIMARY KEY,
  prediction_id  TEXT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  snapshot_json  TEXT NOT NULL,           -- full prediction + components BEFORE the edit
  reason         TEXT,                    -- 'edit' | 'merge' | 'split' | 'accept' | 'dismiss'
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_revisions_prediction_version ON prediction_revisions(prediction_id, version);

CREATE TABLE validation_plans (
  id               TEXT PRIMARY KEY,
  prediction_id    TEXT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL,
  plan_json        TEXT NOT NULL,         -- structured plan (see shared ValidationPlan)
  research_prompt  TEXT NOT NULL,         -- the complete executable prompt text
  provider         TEXT NOT NULL,         -- 'anthropic' | 'openai' | 'lmstudio' | 'user'
  model            TEXT,
  template_version TEXT NOT NULL,         -- 'plan.v1' or 'user-edit'
  edited_by_user   INTEGER NOT NULL DEFAULT 0,
  job_id           TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_plans_prediction_version ON validation_plans(prediction_id, version);

-- Optional user overrides of the built-in prompt templates (SP-10).
CREATE TABLE prompt_templates (
  name        TEXT PRIMARY KEY,           -- 'extraction' | 'plan' | 'assessment'
  body        TEXT NOT NULL,
  base_version TEXT NOT NULL,             -- built-in version the override was derived from
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
