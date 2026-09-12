-- Prediction Ledger — migration 004: local media and resumable transcription (Release 0.4).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.

ALTER TABLE videos ADD COLUMN media_path TEXT;            -- media/<hash>.<ext>, relative to the data directory
ALTER TABLE videos ADD COLUMN media_hash TEXT;            -- sha256 of the uploaded file (duplicate detection)
ALTER TABLE videos ADD COLUMN media_size INTEGER;
ALTER TABLE videos ADD COLUMN audio_path TEXT;            -- artifacts/audio/<hash>.wav (16 kHz mono)
ALTER TABLE videos ADD COLUMN transcription_engine TEXT;  -- 'local-whisper' | 'openai-transcribe'
ALTER TABLE videos ADD COLUMN transcription_model TEXT;
ALTER TABLE videos ADD COLUMN error TEXT;                 -- last recoverable error shown in the Library

CREATE UNIQUE INDEX idx_videos_media_hash ON videos(media_hash) WHERE media_hash IS NOT NULL;

-- Chunk bookkeeping for resumable transcription: a chunk whose status is 'done' is skipped on retry.
CREATE TABLE transcription_chunks (
  video_id       TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  chunk_index    INTEGER NOT NULL,
  start_s        REAL NOT NULL,
  end_s          REAL NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  segment_count  INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (video_id, chunk_index)
);
