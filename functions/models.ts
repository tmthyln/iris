import type {D1Database, R2Bucket} from '@cloudflare/workers-types'
import {asBoolean, asDate, asStringList} from "./utils/conversion";

type PersistenceState = 'new' | 'dirty' | 'persisted'

interface PersistToOptions {
    onConflict?: 'update' | 'ignore'
    updateExcludeFields?: string[]
}

abstract class ServerEntity {
    protected state: PersistenceState = 'new'

    protected constructor(readonly tableName, state: PersistenceState = 'new') {
        this.state = state;
    }

    protected async persistTo(db: D1Database, data, options: PersistToOptions = {}) {
        const {
            onConflict = 'ignore',
            updateExcludeFields = [],
        }: PersistToOptions = options

        const columnNames = Object.keys(data)
        const placeholders = new Array(columnNames.length).fill('?')
        const values = [...Object.values(data)]

        let stmt = `INSERT INTO ${this.tableName} (${columnNames.join(', ')}) VALUES (${placeholders.join(', ')})`;

        if (onConflict === 'ignore') {
            stmt += ' ON CONFLICT DO NOTHING'
        } else if (onConflict === 'update') {
            const updateData = Object.entries(data)
                .filter(([key, _]) => !updateExcludeFields.includes(key))
            const updateAssignments = updateData.map(([key, _]) => `${key} = ?`)
            const updateValues = updateData.map(([_, value]) => value)

            stmt += ` ON CONFLICT DO UPDATE SET ${updateAssignments.join(', ')}`
            values.push(...updateValues)
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

    constructor(data, rawText = null, state: PersistenceState = 'new') {
        super('feed_file', state);

        this.feed_url = data.feed_url;
        this.fetched_at = asDate(data.fetched_at);
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
            fetched_at: this.fetched_at.toISOString(),
            referenced_feed: this.referenced_feed,
            cached_file: this.cached_file,
            sha256_hash: this.sha256_hash,
        }, {
            onConflict: 'ignore',
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

    constructor(data, state: PersistenceState = 'new') {
        super('feed_source', state);

        this.feed_url = data.feed_url
        this.referenced_feed = data.referenced_feed
        this.actively_updating = asBoolean(data.actively_updating ?? 1)
        this.last_updated = asDate(data.last_updated)
        this.last_fetched = asDate(data.last_fetched)
        this.archive = asBoolean(data.archive ?? 0)
        this.primary_source = asBoolean(data.primary_source)
    }

    async persistTo(db) {
        await super.persistTo(db, {
            feed_url: this.feed_url,
            referenced_feed: this.referenced_feed,
            actively_updating: this.actively_updating,
            last_updated: this.last_updated.toISOString(),
            last_fetched: this.last_fetched.toISOString(),
            archive: this.archive,
            primary_source: this.primary_source,
        }, {
            onConflict: 'update',
            updateExcludeFields: ['feed_url'],
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

    constructor(data, state: PersistenceState = 'new') {
        super('feed', state);

        this.guid = data.guid;
        this.input_url = data.input_url;
        this.source_url = data.source_url;
        this.title = data.title
        this.alias = data.alias
        this.description = data.description
        this.author = data.author
        this.type = data.type
        this.ongoing = asBoolean(data.ongoing)
        this.active = asBoolean(data.active)
        this.image_src = data.image_src
        this.image_alt = data.image_alt
        this.last_updated = asDate(data.last_updated)
        this.update_frequency = data.update_frequency
        this.link = data.link ?? ''
        this.categories = asStringList(data.categories)
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
            last_updated: this.last_updated.toISOString(),
            update_frequency: this.update_frequency,
            link: this.link,
            categories: this.categories.join(','),
        }, {
            onConflict: 'update',
            updateExcludeFields: ['guid', 'input_url', 'alias', 'active', 'categories'],
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
    bookmarked: boolean;

    constructor(data, state: PersistenceState = 'new') {
        super('feed_item', state);

        this.guid = data.guid
        this.source_feed = data.source_feed
        this.season = data.season
        this.episode = data.episode
        this.title = data.title
        this.description = data.description
        this.link = data.link
        this.date = asDate(data.date)
        this.enclosure_url = data.enclosure_url
        this.enclosure_length = data.enclosure_length
        this.enclosure_type = data.enclosure_type
        this.duration = data.duration
        this.duration_unit = data.duration_unit
        this.encoded_content = data.encoded_content ?? ''
        this.keywords = asStringList(data.keywords)
        this.finished = asBoolean(data.finished)
        this.progress = data.progress
        this.bookmarked = data.bookmarked ?? false
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
            date: this.date.toISOString(),
            enclosure_url: this.enclosure_url,
            enclosure_length: this.enclosure_length,
            enclosure_type: this.enclosure_type,
            duration: this.duration,
            duration_unit: this.duration_unit,
            encoded_content: this.encoded_content,
            keywords: this.keywords.join(','),
            finished: this.finished,
            progress: this.progress,
            bookmarked: this.bookmarked,
        }, {
            onConflict: 'update',
            updateExcludeFields: ['guid', 'source_feed', 'finished', 'progress'],
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
    bookmarked: boolean;

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
        this.bookmarked = data.bookmarked
    }
}

export class ClientFeedItem extends ClientFeedItemPreview {
    encoded_content: string;

    constructor(data: ServerFeedItem) {
        super(data);

        this.encoded_content = data.encoded_content
    }
}
