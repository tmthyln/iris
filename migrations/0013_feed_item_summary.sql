-- Migration number: 0013 	 2026-11-19T00:00:00.000Z

-- A short generated summary shown in item previews in place of a long
-- description, and the hash of the description text it was made from, so a
-- changed description is summarised again rather than keeping a stale one.
ALTER TABLE feed_item ADD COLUMN summary TEXT;
ALTER TABLE feed_item ADD COLUMN summary_source_hash TEXT;
