-- Migration number: 0000 	 2024-03-09T01:22:52.199Z
DROP TABLE IF EXISTS feed_file;
DROP TABLE IF EXISTS feed_source;
DROP TABLE IF EXISTS feed_item;
DROP TABLE IF EXISTS feed;

CREATE TABLE IF NOT EXISTS feed (
    guid TEXT PRIMARY KEY NOT NULL,
    input_url TEXT NOT NULL,
    source_url TEXT NOT NULL,
    title TEXT NOT NULL,
    alias TEXT NOT NULL,
    description TEXT NOT NULL,
    author TEXT NOT NULL,
    type TEXT NOT NULL,
    ongoing BOOLEAN,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    image_src TEXT,
    image_alt TEXT,
    last_updated DATETIME NOT NULL,
    update_frequency REAL NOT NULL,
    link TEXT NOT NULL,
    categories TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS feed_item (
     guid TEXT PRIMARY KEY NOT NULL,
     source_feed TEXT NOT NULL REFERENCES feed(guid) ON DELETE CASCADE ON UPDATE CASCADE,
     season INTEGER,
     episode INTEGER,
     title TEXT NOT NULL,
     description TEXT NOT NULL,
     link TEXT NOT NULL,
     date DATE,
     enclosure_url TEXT,
     enclosure_length INTEGER,
     enclosure_type TEXT,
     duration REAL,
     duration_unit TEXT,
     encoded_content TEXT NOT NULL,
     keywords TEXT NOT NULL,
     finished BOOLEAN NOT NULL DEFAULT FALSE,
     progress REAL NOT NULL DEFAULT 0.0
) STRICT;

CREATE TABLE IF NOT EXISTS feed_source (
    feed_url TEXT PRIMARY KEY NOT NULL,
    referenced_feed TEXT NOT NULL REFERENCES feed(guid) ON DELETE CASCADE ON UPDATE CASCADE,
    actively_updating BOOLEAN NOT NULL DEFAULT TRUE,
    last_updated DATETIME NOT NULL,
    last_fetched DATETIME NOT NULL,
    archive BOOLEAN NOT NULL DEFAULT FALSE,
    primary_source BOOLEAN NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS feed_file (
    feed_url TEXT NOT NULL REFERENCES feed_source(feed_url) ON DELETE CASCADE ON UPDATE CASCADE,
    fetched_at DATETIME NOT NULL,
    referenced_feed TEXT NOT NULL REFERENCES feed(guid) ON DELETE CASCADE ON UPDATE CASCADE,
    cached_file TEXT NOT NULL,
    sha256_hash TEXT UNIQUE NOT NULL,
    PRIMARY KEY(feed_url, fetched_at)
) STRICT;
