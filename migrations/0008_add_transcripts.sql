-- Migration number: 0008 	 2026-05-28T00:00:00.000Z

CREATE TABLE IF NOT EXISTS transcript (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_item_guid       TEXT    NOT NULL REFERENCES feed_item(guid) ON DELETE CASCADE ON UPDATE CASCADE,
    model                TEXT    NOT NULL,
    language             TEXT,
    source_transcript_id INTEGER REFERENCES transcript(id) ON DELETE SET NULL,
    status               TEXT    NOT NULL,
    text                 TEXT,
    segments_json        TEXT,
    error_message        TEXT,
    requested_at         TEXT    NOT NULL,
    started_at           TEXT,
    completed_at         TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS transcript_by_feed_item ON transcript(feed_item_guid);
