-- Prediction Ledger — migration 005: YouTube ingestion (Release 0.5).
-- Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
-- Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.

ALTER TABLE videos ADD COLUMN youtube_id TEXT;          -- 11-character YouTube video id (duplicate detection)
ALTER TABLE videos ADD COLUMN channel TEXT;             -- uploader/channel name when known
-- How the transcript was obtained: 'captions-manual' | 'captions-auto' | 'transcribed' | 'imported'
ALTER TABLE videos ADD COLUMN transcript_source TEXT;

CREATE UNIQUE INDEX idx_videos_youtube_id ON videos(youtube_id) WHERE youtube_id IS NOT NULL;

UPDATE videos SET transcript_source = 'imported' WHERE source_kind = 'transcript' AND transcript_source IS NULL;
UPDATE videos SET transcript_source = 'transcribed' WHERE source_kind = 'local' AND status = 'ready' AND transcript_source IS NULL;
