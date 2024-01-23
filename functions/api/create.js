
export async function onRequestPost(context) {
    const db = context.env.DB;
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS feed (
            guid TEXT PRIMARY KEY NOT NULL,
            input_url TEXT NOT NULL,
            source_url TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            author TEXT NOT NULL,
            type TEXT NOT NULL,
            ongoing INTEGER,
            active INTEGER NOT NULL DEFAULT 1,
            image_src TEXT NOT NULL,
            image_alt TEXT NOT NULL,
            last_updated TEXT NOT NULL,
            update_frequency REAL NOT NULL,
            link TEXT NOT NULL,
            categories TEXT NOT NULL
                   ) STRICT`),
        db.prepare(`CREATE TABLE IF NOT EXISTS feed_item (
            guid TEXT PRIMARY KEY NOT NULL,
            source_feed TEXT NOT NULL,
            season INTEGER,
            episode INTEGER,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            link TEXT NOT NULL,
            date TEXT,
            enclosure_url TEXT,
            enclosure_length INTEGER,
            enclosure_type TEXT,
            duration REAL,
            duration_unit TEXT,
            encoded_content TEXT NOT NULL,
            keywords TEXT NOT NULL,
            finished INTEGER NOT NULL DEFAULT 0,
            progress REAL NOT NULL DEFAULT 0.0,
            FOREIGN KEY(source_feed) REFERENCES feed(guid) ON DELETE CASCADE ON UPDATE CASCADE
                   ) STRICT`),
        db.prepare(`CREATE TABLE IF NOT EXISTS feed_source (
            feed_url TEXT PRIMARY KEY NOT NULL,
            referenced_feed TEXT NOT NULL,
            actively_updating INTEGER NOT NULL DEFAULT 1,
            last_updated TEXT NOT NULL,
            last_fetched TEXT NOT NULL,
            archive INTEGER NOT NULL DEFAULT 0,
            primary_source INTEGER NOT NULL,
            FOREIGN KEY(referenced_feed) REFERENCES feed(guid) ON DELETE CASCADE ON UPDATE CASCADE
                   ) STRICT`),
        db.prepare(`CREATE TABLE IF NOT EXISTS feed_file (
            feed_url TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            referenced_feed TEXT NOT NULL,
            cached_file TEXT NOT NULL,
            PRIMARY KEY(feed_url, fetched_at),
            FOREIGN KEY(feed_url) REFERENCES feed_source(feed_url) ON DELETE CASCADE ON UPDATE CASCADE,
            FOREIGN KEY(referenced_feed) REFERENCES feed(guid) ON DELETE CASCADE ON UPDATE CASCADE
                   ) STRICT`),
        // TODO create indices
    ])

    return new Response()
}
