-- Prediction Ledger — 1.4: one game record per matchup, shared by every pick on that game.
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.

CREATE TABLE games (
  id            TEXT PRIMARY KEY,
  sport         TEXT NOT NULL,
  league        TEXT,
  matchup_key   TEXT NOT NULL,            -- sport + both nicknames, sorted: "nfl:bills|chiefs"
  team_a        TEXT NOT NULL,            -- as first seen
  team_b        TEXT NOT NULL,
  event_date    TEXT,                     -- YYYY-MM-DD
  event_time    TEXT,
  status        TEXT NOT NULL CHECK (status IN ('scheduled','final','postponed','unknown')),
  score_a       INTEGER,
  score_b       INTEGER,
  overtime      INTEGER NOT NULL DEFAULT 0,
  winner        TEXT,                     -- team_a | team_b | 'tie' | NULL
  source_id     TEXT REFERENCES sources(id) ON DELETE SET NULL,
  source_url    TEXT,
  excerpt       TEXT,                     -- the verbatim score line the result was read from
  lookup_via    TEXT,                     -- 'search snippets' | 'score page' | 'model' | 'user'
  notes_json    TEXT NOT NULL DEFAULT '[]',
  retrieved_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_games_matchup ON games(matchup_key, event_date);

ALTER TABLE predictions ADD COLUMN game_id TEXT REFERENCES games(id) ON DELETE SET NULL;
CREATE INDEX idx_predictions_game ON predictions(game_id);
