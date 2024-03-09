-- Migration number: 0001 	 2024-03-09T02:06:51.959Z

CREATE INDEX IF NOT EXISTS ix_feed__last_updated ON feed(last_updated DESC) WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS ix_feed_item__source_feed ON feed_item(source_feed);

CREATE INDEX IF NOT EXISTS ix_feed_source__referenced_feed ON feed_source(referenced_feed);

CREATE INDEX IF NOT EXISTS ix_feed_file__feed_url ON feed_file(feed_url);
CREATE INDEX IF NOT EXISTS ix_feed_file__referenced_feed ON feed_file(referenced_feed);
