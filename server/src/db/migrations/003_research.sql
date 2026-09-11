-- Prediction Ledger — migration 003: research runs, sources, evidence, assessments (Release 0.3).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
--
-- Rules baked in (docs/ARCHITECTURE.md §5.2, ADR-006, ADR-007):
--  * A research run is bound to ONE validation plan version. Its evidence set is immutable once completed.
--  * Sources are only rows the application itself retrieved. Evidence excerpts must be found in the
--    stored source text (verified at insert time by the evidence job).
--  * Assessments are versioned per prediction and reference the run (hence the evidence set),
--    the plan version, provider/model, template, and research date.

CREATE TABLE research_runs (
  id                  TEXT PRIMARY KEY,
  prediction_id       TEXT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  validation_plan_id  TEXT NOT NULL REFERENCES validation_plans(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','completed','failed','cancelled')),
  search_provider     TEXT NOT NULL,
  cutoff_date         TEXT NOT NULL,           -- research cutoff (YYYY-MM-DD)
  queries_json        TEXT NOT NULL DEFAULT '[]',  -- [{group, query, resultCount, error?}]
  coverage_notes_json TEXT NOT NULL DEFAULT '[]',  -- human-readable limitations
  searches_used       INTEGER NOT NULL DEFAULT 0,
  sources_fetched     INTEGER NOT NULL DEFAULT 0,
  sources_failed      INTEGER NOT NULL DEFAULT 0,
  evidence_provider   TEXT,                    -- LLM used to extract evidence items
  evidence_model      TEXT,
  evidence_template   TEXT,
  job_id              TEXT,
  error               TEXT,
  started_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at         TEXT
);
CREATE INDEX idx_runs_prediction ON research_runs(prediction_id, started_at);

-- One row per retrieved page (deduplicated by canonical URL). Shared across runs.
CREATE TABLE sources (
  id             TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  canonical_url  TEXT NOT NULL,
  title          TEXT,
  publisher      TEXT,                        -- hostname unless a better name is found
  published_at   TEXT,                        -- from meta tags / JSON-LD when present
  retrieved_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fetch_status   TEXT NOT NULL CHECK (fetch_status IN ('ok','blocked','error','too_large','timeout','unsupported')),
  http_status    INTEGER,
  content_type   TEXT,
  content_path   TEXT,                        -- artifacts/sources/<hash>.txt (extracted text)
  content_hash   TEXT,                        -- sha256 of extracted text; equal hashes ⇒ syndicated copy
  content_chars  INTEGER,
  syndicated_of  TEXT REFERENCES sources(id) ON DELETE SET NULL,
  access_notes   TEXT
);
CREATE UNIQUE INDEX idx_sources_canonical ON sources(canonical_url);
CREATE INDEX idx_sources_hash ON sources(content_hash);

-- Search-result rows for a run (what the search provider returned, fetched or not).
CREATE TABLE run_results (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  query_group   TEXT NOT NULL CHECK (query_group IN ('neutral','supporting','disconfirming')),
  query         TEXT NOT NULL,
  rank          INTEGER NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT,
  snippet       TEXT,
  page_age      TEXT,
  source_id     TEXT REFERENCES sources(id) ON DELETE SET NULL,
  fetched       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_run_results_run ON run_results(run_id);

CREATE TABLE evidence_items (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  source_id      TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  component_id   TEXT REFERENCES prediction_components(id) ON DELETE SET NULL,
  stance         TEXT NOT NULL CHECK (stance IN ('supports','contradicts','context')),
  excerpt        TEXT NOT NULL,               -- verified to occur in the source text
  fact           TEXT,                        -- one-sentence extracted fact
  event_date     TEXT,                        -- YYYY-MM-DD when stated
  action_stage   TEXT CHECK (action_stage IN ('proposed','announced','enacted','approved','completed','other')),
  in_window      INTEGER,                     -- 1 = event_date <= deadline (or deadline unknown), 0 = later development, NULL = undated
  quality_notes  TEXT,
  independent    INTEGER NOT NULL DEFAULT 1,  -- 0 when the source is a syndicated copy of another cited source
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_evidence_run ON evidence_items(run_id);
CREATE INDEX idx_evidence_component ON evidence_items(component_id);

CREATE TABLE assessments (
  id                   TEXT PRIMARY KEY,
  prediction_id        TEXT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  run_id               TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  validation_plan_id   TEXT NOT NULL REFERENCES validation_plans(id) ON DELETE CASCADE,
  version              INTEGER NOT NULL,
  evidence_assessment  TEXT NOT NULL CHECK (evidence_assessment IN ('supported','partially_supported','contradicted','insufficient','not_assessable')),
  time_status          TEXT NOT NULL CHECK (time_status IN ('pending','reached','unknown')),
  explanation          TEXT NOT NULL,
  uncertainty          TEXT,
  confidence           TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  confidence_rationale TEXT,
  supporting_ids_json  TEXT NOT NULL DEFAULT '[]',
  contradicting_ids_json TEXT NOT NULL DEFAULT '[]',
  citations_json       TEXT NOT NULL DEFAULT '[]',   -- [{claim, evidenceIds[]}]
  later_developments   TEXT,                         -- developments after the deadline, reported separately
  guard_notes_json     TEXT NOT NULL DEFAULT '[]',   -- app-side rule adjustments applied to the model's verdict
  provider             TEXT NOT NULL,                -- 'anthropic' | 'openai' | 'lmstudio' | 'app' (deterministic)
  model                TEXT,
  template_version     TEXT NOT NULL,
  researched_at        TEXT NOT NULL,
  recheck_after        TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_assessments_prediction_version ON assessments(prediction_id, version);

CREATE TABLE component_assessments (
  id             TEXT PRIMARY KEY,
  assessment_id  TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  component_id   TEXT REFERENCES prediction_components(id) ON DELETE SET NULL,
  component_kind TEXT NOT NULL,
  statement      TEXT NOT NULL,
  assessment     TEXT NOT NULL CHECK (assessment IN ('supported','partially_supported','contradicted','insufficient','not_assessable')),
  explanation    TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_component_assessments ON component_assessments(assessment_id);

-- 24-hour cache of search results per provider+query (PS-04).
CREATE TABLE search_cache (
  cache_key    TEXT PRIMARY KEY,              -- provider + '|' + normalized query
  results_json TEXT NOT NULL,
  cached_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
