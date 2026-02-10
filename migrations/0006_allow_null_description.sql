-- Migration number: 0006
-- Allow feed_item.description to be NULL (some RSS items lack a description)
-- SQLite does not support ALTER COLUMN, so we recreate the table.

CREATE TABLE feed_item_new (
    guid TEXT PRIMARY KEY NOT NULL,
    source_feed TEXT NOT NULL REFERENCES feed(guid) ON DELETE CASCADE ON UPDATE CASCADE,
    season INTEGER,
    episode INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    link TEXT NOT NULL,
    date TEXT,
    enclosure_url TEXT,
    enclosure_length INTEGER,
    enclosure_type TEXT,
    duration REAL,
    duration_unit TEXT,
    encoded_content TEXT NOT NULL,
    keywords TEXT NOT NULL,
    finished INTEGER NOT NULL DEFAULT FALSE,
    progress REAL NOT NULL DEFAULT 0.0,
    bookmarked INTEGER NOT NULL DEFAULT FALSE
) STRICT;

INSERT INTO feed_item_new SELECT * FROM feed_item;
DROP TABLE feed_item;
ALTER TABLE feed_item_new RENAME TO feed_item;

-- Recreate indexes that were on the original table
CREATE INDEX IF NOT EXISTS ix_feed_item__source_feed ON feed_item(source_feed);
CREATE INDEX IF NOT EXISTS ix_feed_item__date ON feed_item(date DESC);
CREATE INDEX IF NOT EXISTS ix_feed_item__bookmarked ON feed_item(guid) WHERE bookmarked = true;
