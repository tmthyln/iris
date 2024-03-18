-- Migration number: 0002 	 2024-03-12T04:45:10.160Z

ALTER TABLE feed_item ADD COLUMN bookmarked INTEGER NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ix_feed_item__bookmarked ON feed_item(guid) WHERE bookmarked = true;
