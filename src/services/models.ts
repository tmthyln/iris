import type {D1Database, R2Bucket} from '@cloudflare/workers-types'
import {asBoolean, asDate, asStringList} from "../lib/conversion";

interface PersistOptions {
    onConflict?: 'update' | 'ignore'
    updateExcludeFields?: string[]
}

interface IncludeForTextSearchInput {
    title: string
    alias?: string
    description: string | null
    author?: string
    content?: string
    categories?: string[]
    keywords?: string[]
    guid: string
}

abstract class ServerEntity {

    protected constructor(
        readonly tableName: string,
        readonly persistOptions: PersistOptions = {onConflict: 'ignore'},
        private deferred: boolean = false,
    ) {}

    defer() {
        this.deferred = true;
        return this
    }
    focus() {
        this.deferred = false;
        return this
    }

    protected async persistTo(db: D1Database, data: Record<string, unknown>) {
        const {
            onConflict = 'ignore',
            updateExcludeFields = [],
        }: PersistOptions = this.persistOptions

        const columnNames = Object.keys(data)
        const placeholders: string[] = new Array(columnNames.length).fill('?')
        const values = [...Object.values(data)]

        let stmt = `INSERT INTO ${this.tableName} (${columnNames.join(', ')}) VALUES (${placeholders.join(', ')})`;

        if (this.deferred || onConflict === 'ignore') {
            stmt += ' ON CONFLICT DO NOTHING'
        } else if (onConflict === 'update') {
            const updateData = Object.entries(data)
                .filter(([key, _]) => !updateExcludeFields.includes(key))
            const updateAssignments = updateData.map(([key, _]) => `${key} = ?`)
            const updateValues = updateData.map(([_, value]) => value)

            stmt += ` ON CONFLICT DO UPDATE SET ${updateAssignments.join(', ')}`
            values.push(...updateValues)
        }

        try {
            await db.prepare(stmt).bind(...values).run()
        } catch (error) {
            console.error(`[D1 Error] Failed to persist to table "${this.tableName}"`)
            console.error('Statement:', stmt)
            console.error('Bind values:', JSON.stringify(values, null, 2))
            console.error('Data:', JSON.stringify(data, null, 2))
            if (error instanceof Error) {
                if ('cause' in error) {
                    console.error(error.cause)
                } else {
                    console.error(error.message)
                }
            }
            console.error()
            throw error
        }

        return this
    }

    async includeForTextSearch(db: D1Database, input: IncludeForTextSearchInput) {
        const {
            title,
            alias= '',
            description = '',
            author = '',
            content = '',
            categories = [],
            keywords = [],
            guid,
        } = input

        // SQLite doesn't support UPSERT for virtual tables

        const existingRecord = await db
            .prepare('SELECT guid FROM text_search WHERE guid = ? AND table_name = ?')
            .bind(guid, this.tableName)
            .first()

        if (existingRecord) {
            await db
                .prepare(`
                    UPDATE text_search SET
                        title = ?,
                        alias = ?,
                        description = ?,
                        author = ?,
                        content = ?,
                        categories = ?,
                        keywords = ?
                    WHERE guid = ? AND table_name = ?
                `)
                .bind(
                    title, alias, description, author, content, categories.join(','), keywords.join(','),
                    guid, this.tableName,
                )
                .run()
        } else {
            await db
                .prepare(`
                    INSERT INTO text_search (
                        title, alias, description, author, content, categories, keywords,
                        guid, table_name
                    ) VALUES (
                         ?, ?, ?, ?, ?, ?, ?,
                         ?, ?
                    )`)
                .bind(
                    title, alias, description, author, content, categories.join(','), keywords.join(','),
                    guid, this.tableName,
                )
                .run()
        }

        return this
    }

}

export interface RawFeedFile {
    feed_url: string
    fetched_at: string | Date
    referenced_feed: string
    cached_file: string
    sha256_hash: string
}

export class ServerFeedFile extends ServerEntity {
    readonly feed_url: string;
    readonly fetched_at: Date;
    readonly referenced_feed: string;
    readonly cached_file: string;
    readonly sha256_hash: string;

    #rawText: string | null;

    constructor(data: RawFeedFile, rawText: string | null = null) {
        super('feed_file');

        this.feed_url = data.feed_url;
        this.fetched_at = asDate(data.fetched_at);
        this.referenced_feed = data.referenced_feed;
        this.cached_file = data.cached_file;
        this.sha256_hash = data.sha256_hash;

        this.#rawText = rawText;
    }

    async persistTo(db: D1Database, bucket: R2Bucket) {
        if (this.#rawText) {
            await bucket.put(this.cached_file, this.#rawText)
        }

        return await super.persistTo(db, {
            feed_url: this.feed_url,
            fetched_at: this.fetched_at.toISOString(),
            referenced_feed: this.referenced_feed,
            cached_file: this.cached_file,
            sha256_hash: this.sha256_hash,
        });
    }

    async text(bucket?: R2Bucket) {
        if (this.#rawText || !bucket) {
            return this.#rawText
        }

        const object = await bucket.get(this.cached_file)
        if (object) {
            const text = await object.text()
            this.#rawText = text
            return text
        }

        return null
    }

    static async get(db: D1Database, feedUrl: string, fetchedAt: Date) {
        const rawFeedFile = await db
            .prepare('SELECT * FROM feed_file WHERE feed_url = ? AND datetime(fetched_at) = datetime(?)')
            .bind(feedUrl, fetchedAt.toISOString())
            .first<RawFeedFile>()

        return rawFeedFile !== null ? new ServerFeedFile(rawFeedFile, null) : null
    }

    static async getByContentHash(db: D1Database, contentHash: string) {
        const rawFeedFile = await db
            .prepare('SELECT * FROM feed_file WHERE sha256_hash = ?')
            .bind(contentHash)
            .first<RawFeedFile>()

        return rawFeedFile !== null ? new ServerFeedFile(rawFeedFile, null) : null
    }
}

export interface RawFeedSource {
    feed_url: string
    referenced_feed: string
    actively_updating: number | boolean
    last_updated: string | Date
    last_fetched: string | Date
    archive: number | boolean
    primary_source: number | boolean
}

export class ServerFeedSource extends ServerEntity {
    feed_url: string;
    referenced_feed: string;
    actively_updating: boolean;
    last_updated: Date;
    last_fetched: Date;
    archive: boolean;
    primary_source: boolean;

    constructor(data: RawFeedSource) {
        super('feed_source', {
            onConflict: 'update',
            updateExcludeFields: ['feed_url'],
        });

        this.feed_url = data.feed_url
        this.referenced_feed = data.referenced_feed
        this.actively_updating = asBoolean(data.actively_updating ?? 1)
        this.last_updated = asDate(data.last_updated)
        this.last_fetched = asDate(data.last_fetched)
        this.archive = asBoolean(data.archive ?? 0)
        this.primary_source = asBoolean(data.primary_source)
    }

    async persistTo(db: D1Database) {
        return await super.persistTo(db, {
            feed_url: this.feed_url,
            referenced_feed: this.referenced_feed,
            actively_updating: this.actively_updating,
            last_updated: this.last_updated.toISOString(),
            last_fetched: this.last_fetched.toISOString(),
            archive: this.archive,
            primary_source: this.primary_source,
        })
    }

    static async get(db: D1Database, url: string) {
        const rawFeedSource = await db
            .prepare('SELECT * FROM feed_source WHERE feed_url = ?')
            .bind(url)
            .first<RawFeedSource>()

        return rawFeedSource !== null ? new ServerFeedSource(rawFeedSource) : null
    }
}

export interface RawFeed {
    guid: string
    input_url: string
    source_url: string
    title: string
    alias: string
    description: string
    author: string
    type: "podcast" | "blog"
    ongoing: number | boolean | null
    active: number | boolean
    image_src: string | null
    image_alt: string | null
    last_updated: string | Date
    update_frequency: number
    link: string
    categories: string
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

    constructor(data: RawFeed) {
        super('feed', {
            onConflict: 'update',
            updateExcludeFields: ['guid', 'input_url', 'alias', 'active', 'categories'],
        });

        this.guid = data.guid;
        this.input_url = data.input_url;
        this.source_url = data.source_url;
        this.title = data.title
        this.alias = data.alias
        this.description = data.description
        this.author = data.author
        this.type = data.type
        this.ongoing = data.ongoing ? asBoolean(data.ongoing) : null
        this.active = asBoolean(data.active)
        this.image_src = data.image_src
        this.image_alt = data.image_alt
        this.last_updated = asDate(data.last_updated)
        this.update_frequency = data.update_frequency
        this.link = data.link ?? ''
        this.categories = asStringList(data.categories)
    }

    async persistTo(db: D1Database) {
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
        })

        return await super.includeForTextSearch(db, this)
    }

    async feedSources(db: D1Database) {
        const {results} = await db
            .prepare('SELECT * FROM feed_source WHERE referenced_feed = ?')
            .bind(this.guid)
            .all<RawFeedSource>()

        return results.map(item => new ServerFeedSource(item))
    }

    static async get(db: D1Database, guid: string) {
        const rawFeed = await db.prepare('SELECT * FROM feed WHERE guid = ?')
            .bind(guid)
            .first<RawFeed>()

        return rawFeed !== null ? new ServerFeed(rawFeed) : null
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

export interface RawFeedItem {
    guid: string
    source_feed: string
    season: number | null
    episode: number | null
    title: string
    description: string | null
    link: string
    date: string | Date | null
    enclosure_url: string | null
    enclosure_length: number | null
    enclosure_type: string | null
    duration: number | null
    duration_unit: string | null
    encoded_content: string
    keywords: string
    finished: number | boolean
    progress: number
    bookmarked?: number | boolean
}

export class ServerFeedItem extends ServerEntity {
    guid: string;
    source_feed: string;
    season: number | null;
    episode: number | null;
    title: string;
    description: string | null;
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

    constructor(data: RawFeedItem) {
        super('feed_item', {
            onConflict: 'update',
            updateExcludeFields: ['guid', 'source_feed', 'finished', 'progress'],
        });

        this.guid = data.guid
        this.source_feed = data.source_feed
        this.season = data.season
        this.episode = data.episode
        this.title = data.title
        this.description = data.description
        this.link = data.link
        this.date = data.date ? asDate(data.date) : null
        this.enclosure_url = data.enclosure_url
        this.enclosure_length = data.enclosure_length
        this.enclosure_type = data.enclosure_type
        this.duration = data.duration
        this.duration_unit = data.duration_unit
        this.encoded_content = data.encoded_content ?? ''
        this.keywords = asStringList(data.keywords)
        this.finished = asBoolean(data.finished)
        this.progress = data.progress
        this.bookmarked = asBoolean(data.bookmarked ?? false)
    }

    async persistTo(db: D1Database) {
        await super.persistTo(db, {
            guid: this.guid,
            source_feed: this.source_feed,
            season: this.season,
            episode: this.episode,
            title: this.title,
            description: this.description,
            link: this.link,
            date: this.date ? this.date.toISOString() : null,
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
        })

        return await super.includeForTextSearch(db, this)
    }

    static async get(db: D1Database, guid: string) {
        const rawFeedItem = await db
            .prepare('SELECT * FROM feed_item WHERE guid = ?')
            .bind(guid)
            .first<RawFeedItem>()

        return rawFeedItem !== null ? new ServerFeedItem(rawFeedItem) : null
    }
}

export class ClientFeedItemPreview {
    guid: string;
    source_feed: string;
    season: number | null;
    episode: number | null;
    title: string;
    description: string | null;
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
