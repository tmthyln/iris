import {unixEpoch} from "./utils/dates";
import type {D1Database, R2Bucket} from '@cloudflare/workers-types'

abstract class ServerEntity {

    protected constructor(protected readonly tableName: string) {}

    protected async persistTo(db: D1Database, data, on_conflict: string | null = 'DO NOTHING') {
        const columnNames = Object.keys(data)
        const placeholders = new Array(columnNames.length).fill('?')
        const values = Object.values(data)
        let stmt = `INSERT INTO ${this.tableName} (${columnNames.join(', ')}) VALUES (${placeholders.join(', ')})`;
        if (on_conflict !== null) {
            stmt += ` ON CONFLICT ${on_conflict}`
        }

        await db.prepare(stmt).bind(...values).run()
    }
}

export class ServerFeedFile extends ServerEntity {
    feed_url: string;
    fetched_at: Date;
    referenced_feed: string;
    cached_file: string;
    sha256_hash: string;

    readonly #rawText: string;

    constructor(data, rawText = null) {
        super('feed_file');

        this.feed_url = data.feed_url;
        this.fetched_at = data.fetched_at;
        this.referenced_feed = data.referenced_feed;
        this.cached_file = data.cached_file;
        this.sha256_hash = data.sha256_hash;

        this.#rawText = rawText;
    }

    async persistTo(db, bucket: R2Bucket) {
        if (this.#rawText) {
            await bucket.put(this.cached_file, this.#rawText)
        }

        await super.persistTo(db, {
            feed_url: this.feed_url,
            fetched_at: unixEpoch(this.fetched_at),
            referenced_feed: this.referenced_feed,
            cached_file: this.cached_file,
            sha256_hash: this.sha256_hash,
        });
    }
}

export class ServerFeedSource extends ServerEntity {
    feed_url: string;
    referenced_feed: string;
    actively_updating: boolean;
    last_updated: Date;
    last_fetched: Date;
    archive: boolean;
    primary_source: boolean;

    constructor(data) {
        super('feed_source');

        this.feed_url = data.feed_url
        this.referenced_feed = data.referenced_feed
        this.actively_updating = Boolean(parseInt(data.actively_updating ?? 1))
        this.last_updated = data.last_updated
        this.last_fetched = data.last_fetched
        this.archive = Boolean(parseInt(data.archive ?? 0))
        this.primary_source = Boolean(parseInt(data.primary_source))
    }

    async persistTo(db) {
        await super.persistTo(db, {
            feed_url: this.feed_url,
            referenced_feed: this.referenced_feed,
            actively_updating: this.actively_updating,
            last_updated: unixEpoch(this.last_updated),
            last_fetched: unixEpoch(this.last_fetched),
            archive: this.archive,
            primary_source: this.primary_source,
        })
    }
}

export class ServerFeed extends ServerEntity {
    guid: string;
    input_url: string;
    source_url: string;
    title: string;
    alias: string;
    description: string;
    author: string;
    type: 'podcast' | 'blog';
    ongoing: boolean | null;
    active: boolean;
    image_src: string | null;
    image_alt: string | null;
    last_updated: Date;
    update_frequency: number;
    link: string;
    categories: string[];

    constructor(data) {
        super('feed');

        this.guid = data.guid;
        this.input_url = data.input_url;
        this.source_url = data.source_url;
        this.title = data.title
        this.alias = data.alias
        this.description = data.description
        this.author = data.author
        this.type = data.type
        this.ongoing = data.ongoing !== null ? Boolean(parseInt(data.ongoing)) : null
        this.active = Boolean(parseInt(data.active))
        this.image_src = data.image_src
        this.image_alt = data.image_alt
        this.last_updated = data.last_updated
        this.update_frequency = data.update_frequency
        this.link = data.link
        this.categories = data.categories.split(',').filter(seg => seg.trim().length > 0)
    }

    async persistTo(db) {
        await super.persistTo(db, {
            guid: this.guid,
            input_url: this.input_url,
            source_url: this.source_url,
            title: this.title,
            alias: this.alias,
            description: this.description,
            author: this.author,
            type: this.type,
            ongoing: this.ongoing,
            active: this.active,
            image_src: this.image_src,
            image_alt: this.image_alt,
            last_updated: unixEpoch(this.last_updated),
            update_frequency: this.update_frequency,
            link: this.link,
            categories: this.categories.join(','),
        })
    }
}

export class ClientFeed {
    guid: string;
    source_url: string;
    title: string;
    alias: string;
    description: string;
    author: string;
    type: 'podcast' | 'blog';
    ongoing: boolean | null;
    active: boolean;
    image_src: string | null;
    image_alt: string | null;
    last_updated: Date;
    update_frequency: number;
    link: string;
    categories: string[];

    constructor(data: ServerFeed) {
        this.guid = data.guid
        this.source_url = data.source_url
        this.title = data.title
        this.alias = data.alias
        this.description = data.description
        this.author = data.author
        this.type = data.type
        this.ongoing = data.ongoing
        this.active = data.active
        this.image_src = data.image_src
        this.image_alt = data.image_alt
        this.last_updated = data.last_updated
        this.update_frequency = data.update_frequency
        this.link = data.link
        this.categories = data.categories
    }
}

export class ServerFeedItem extends ServerEntity {
    guid: string;
    source_feed: string;
    season: number | null;
    episode: number | null;
    title: string;
    description: string;
    link: string;
    date: Date | null;
    enclosure_url: string | null;
    enclosure_length: number | null;
    enclosure_type: string | null;
    duration: number | null;
    duration_unit: string | null;
    encoded_content: string;
    keywords: string[];
    finished: boolean;
    progress: number;

    constructor(data) {
        super('feed_item');

        this.guid = data.guid
        this.source_feed = data.source_feed
        this.season = data.season
        this.episode = data.episode
        this.title = data.title
        this.description = data.description
        this.link = data.link
        this.date = data.date
        this.enclosure_url = data.enclosure_url
        this.enclosure_length = data.enclosure_length
        this.enclosure_type = data.enclosure_type
        this.duration = data.duration
        this.duration_unit = data.duration_unit
        this.encoded_content = data.encoded_content
        this.keywords = data.keywords
        this.finished = data.finished
        this.progress = data.progress
    }

    async persistTo(db) {
        await super.persistTo(db, {
            guid: this.guid,
            source_feed: this.source_feed,
            season: this.season,
            episode: this.episode,
            title: this.title,
            description: this.description,
            link: this.link,
            date: unixEpoch(this.date),
            enclosure_url: this.enclosure_url,
            enclosure_length: this.enclosure_length,
            enclosure_type: this.enclosure_type,
            duration: this.duration,
            duration_unit: this.duration_unit,
            encoded_content: this.encoded_content,
            keywords: this.keywords.join(','),
            finished: this.finished,
            progress: this.progress,
        })
    }
}

export class ClientFeedItemPreview {
    guid: string;
    source_feed: string;
    season: number | null;
    episode: number | null;
    title: string;
    description: string;
    link: string;
    date: Date | null;
    enclosure_url: string | null;
    enclosure_length: number | null;
    enclosure_type: string | null;
    duration: number | null;
    duration_unit: string | null;
    keywords: string[];
    finished: boolean;
    progress: number;

    constructor(data: ServerFeedItem) {
        this.guid = data.guid
        this.source_feed = data.source_feed
        this.season = data.season
        this.episode = data.episode
        this.title = data.title
        this.description = data.description
        this.link = data.link
        this.date = data.date
        this.enclosure_url = data.enclosure_url
        this.enclosure_length = data.enclosure_length
        this.enclosure_type = data.enclosure_type
        this.duration = data.duration
        this.duration_unit = data.duration_unit
        this.keywords = data.keywords
        this.finished = data.finished
        this.progress = data.progress
    }
}

export class ClientFeedItem extends ClientFeedItemPreview {
    encoded_content: string;

    constructor(data: ServerFeedItem) {
        super(data);

        this.encoded_content = data.encoded_content
    }
}
