-- Migration number: 0011 	 2026-11-03T00:00:00.000Z

-- Partial transcripts: `text`/`segments_json` of an unfinished transcript hold
-- the first `chunks_done` of `chunks_total` chunks. `last_progress_at` lets the
-- API fail a Workflow that claims to be running but has stopped advancing.
ALTER TABLE transcript ADD COLUMN chunks_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transcript ADD COLUMN chunks_total INTEGER;
ALTER TABLE transcript ADD COLUMN last_progress_at TEXT;
