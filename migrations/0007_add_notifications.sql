-- Migration number: 0007 	 2026-05-10T00:00:00.000Z
ALTER TABLE feed ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT FALSE;

ALTER TABLE feed_item ADD COLUMN content_hash TEXT;

CREATE TABLE IF NOT EXISTS notification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    feed_guid TEXT NOT NULL REFERENCES feed(guid) ON DELETE CASCADE ON UPDATE CASCADE,
    feed_item_guid TEXT NOT NULL REFERENCES feed_item(guid) ON DELETE CASCADE ON UPDATE CASCADE,
    created_at TEXT NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT FALSE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification(dismissed, created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscription (
    endpoint TEXT PRIMARY KEY NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
) STRICT;
