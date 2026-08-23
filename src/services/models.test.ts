import {env} from 'cloudflare:workers'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {
    ClientFeed,
    ClientFeedItem,
    ClientFeedItemPreview,
    ClientTranscript,
    ClientTranscriptFull,
    getCombinedTextSearchContent,
    ServerFeed,
    ServerFeedFile,
    ServerFeedItem,
    ServerFeedSource,
    ServerNotification,
    ServerPushSubscription,
    ServerTranscript,
    type RawTranscript,
} from './models'
import {countRows, dateAt, rawFeed, rawFeedItem, rawFeedSource, resetStorage, seedFeed, seedFeedItem} from './testing/fixtures'

const db = env.DB

beforeEach(() => resetStorage())
afterEach(() => {
    vi.restoreAllMocks()
})

async function textSearchRow(guid: string) {
    return db.prepare('SELECT * FROM text_search WHERE guid = ?').bind(guid)
        .first<{title: string, alias: string, description: string, author: string, content: string, categories: string, keywords: string, table_name: string}>()
}

/******************************************************************************
 * ServerFeed
 *****************************************************************************/

describe('ServerFeed', () => {
    test('normalises raw SQLite values', () => {
        const feed = new ServerFeed(rawFeed({
            ongoing: 1,
            active: 0,
            last_updated: '2024-05-06T07:08:09.000Z',
            categories: ' tech, news ,,science ',
            notify_enabled: 1,
            has_unread: 1,
            has_archives: 0,
        }))

        expect(feed.ongoing).toBe(true)
        expect(feed.active).toBe(false)
        expect(feed.last_updated).toEqual(new Date('2024-05-06T07:08:09.000Z'))
        expect(feed.categories).toEqual(['tech', 'news', 'science'])
        expect(feed.notify_enabled).toBe(true)
        expect(feed.has_unread).toBe(true)
        expect(feed.has_archives).toBe(false)
    })

    test('defaults optional raw fields', () => {
        const raw = rawFeed({ongoing: null, has_unread: undefined, has_archives: undefined})
        delete (raw as Partial<typeof raw>).notify_enabled
        const feed = new ServerFeed({...raw, link: null as unknown as string})

        expect(feed.ongoing).toBeNull()
        expect(feed.link).toBe('')
        expect(feed.notify_enabled).toBe(false)
        expect(feed.has_unread).toBe(false)
        expect(feed.has_archives).toBe(false)
    })

    test('persistTo inserts the row and indexes it for text search', async () => {
        const feed = await seedFeed({guid: 'feed-a', title: 'Hello World', alias: 'hw', categories: 'a,b', author: 'Ann'})

        const stored = await ServerFeed.get(db, 'feed-a')
        expect(stored).not.toBeNull()
        expect(stored!.title).toBe('Hello World')
        expect(stored!.categories).toEqual(['a', 'b'])
        expect(stored!.has_archives).toBe(false)
        expect(stored!.last_updated).toEqual(feed.last_updated)

        const indexed = await textSearchRow('feed-a')
        expect(indexed).toMatchObject({title: 'Hello World', alias: 'hw', author: 'Ann', categories: 'a,b', table_name: 'feed'})
    })

    test('persistTo updates on conflict but keeps the user-owned columns', async () => {
        const original = await seedFeed({guid: 'feed-a', title: 'Old', alias: 'mine', categories: 'x', notify_enabled: true, active: true, input_url: 'https://in/1'})

        await new ServerFeed(rawFeed({
            guid: 'feed-a', title: 'New', alias: 'theirs', categories: 'y', notify_enabled: false, active: false, input_url: 'https://in/2',
        })).persistTo(db)

        const stored = (await ServerFeed.get(db, 'feed-a'))!
        expect(stored.title).toBe('New')
        expect(stored.alias).toBe('theirs')  // alias is not excluded from updates
        expect(stored.categories).toEqual(['x'])
        expect(stored.notify_enabled).toBe(true)
        expect(stored.active).toBe(true)
        expect(stored.input_url).toBe('https://in/1')
        expect(stored.source_url).not.toBe(original.source_url)

        // the text search row is updated in place, not duplicated
        const {results} = await db.prepare('SELECT title FROM text_search WHERE guid = ?').bind('feed-a').all<{title: string}>()
        expect(results).toEqual([{title: 'New'}])
    })

    test('defer() makes a conflicting persist a no-op', async () => {
        await seedFeed({guid: 'feed-a', title: 'Old'})
        await new ServerFeed(rawFeed({guid: 'feed-a', title: 'New'})).defer().persistTo(db)
        expect((await ServerFeed.get(db, 'feed-a'))!.title).toBe('Old')

        await new ServerFeed(rawFeed({guid: 'feed-a', title: 'Newer'})).defer().focus().persistTo(db)
        expect((await ServerFeed.get(db, 'feed-a'))!.title).toBe('Newer')
    })

    test('persistTo logs and rethrows database errors', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        // STRICT table: update_frequency must be REAL
        const feed = new ServerFeed(rawFeed({update_frequency: 'often' as unknown as number}))

        await expect(feed.persistTo(db)).rejects.toThrow()
        expect(error).toHaveBeenCalledWith('[D1 Error] Failed to persist to table "feed"')
    })

    test('get returns null for an unknown guid and reports has_archives', async () => {
        expect(await ServerFeed.get(db, 'nope')).toBeNull()

        await seedFeed({guid: 'feed-a'})
        await new ServerFeedSource(rawFeedSource('feed-a', {archive: true})).persistTo(db)
        expect((await ServerFeed.get(db, 'feed-a'))!.has_archives).toBe(true)
    })

    test('feedSources lists the sources that reference the feed', async () => {
        const feed = await seedFeed({guid: 'feed-a'})
        const other = await seedFeed({guid: 'feed-b'})
        await new ServerFeedSource(rawFeedSource('feed-a', {feed_url: 'https://a/1'})).persistTo(db)
        await new ServerFeedSource(rawFeedSource('feed-a', {feed_url: 'https://a/2'})).persistTo(db)
        await new ServerFeedSource(rawFeedSource('feed-b', {feed_url: 'https://b/1'})).persistTo(db)

        const sources = await feed.feedSources(db)
        expect(sources.map(s => s.feed_url).sort()).toEqual(['https://a/1', 'https://a/2'])
        expect(sources[0]).toBeInstanceOf(ServerFeedSource)
        expect((await other.feedSources(db)).map(s => s.feed_url)).toEqual(['https://b/1'])
    })
})

describe('ClientFeed', () => {
    test('exposes the client fields and drops input_url', () => {
        const feed = new ServerFeed(rawFeed({guid: 'feed-a', input_url: 'https://secret', categories: 'a,b', has_unread: 1}))
        const client = new ClientFeed(feed)

        expect(client).not.toHaveProperty('input_url')
        expect(client).toMatchObject({
            guid: 'feed-a',
            categories: ['a', 'b'],
            has_unread: true,
            has_archives: false,
            last_updated: feed.last_updated,
        })
        expect(Object.keys(client).sort()).toEqual([
            'active', 'alias', 'author', 'categories', 'description', 'guid', 'has_archives', 'has_unread',
            'image_alt', 'image_src', 'last_updated', 'link', 'notify_enabled', 'ongoing', 'source_url',
            'title', 'type', 'update_frequency',
        ])
    })
})

/******************************************************************************
 * ServerFeedSource
 *****************************************************************************/

describe('ServerFeedSource', () => {
    test('normalises booleans and dates, defaulting actively_updating and archive', () => {
        const raw = rawFeedSource('feed-a', {primary_source: 1, last_updated: '2024-01-02T00:00:00.000Z'})
        delete (raw as Partial<typeof raw>).actively_updating
        delete (raw as Partial<typeof raw>).archive
        const source = new ServerFeedSource(raw)

        expect(source.actively_updating).toBe(true)
        expect(source.archive).toBe(false)
        expect(source.primary_source).toBe(true)
        expect(source.last_updated).toEqual(new Date('2024-01-02T00:00:00.000Z'))
    })

    test('persistTo inserts, then updates every column but the key', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b'})
        await new ServerFeedSource(rawFeedSource('feed-a', {feed_url: 'https://src', archive: false})).persistTo(db)
        await new ServerFeedSource(rawFeedSource('feed-b', {feed_url: 'https://src', archive: true, actively_updating: false})).persistTo(db)

        const stored = (await ServerFeedSource.get(db, 'https://src'))!
        expect(stored.referenced_feed).toBe('feed-b')
        expect(stored.archive).toBe(true)
        expect(stored.actively_updating).toBe(false)
        expect(await countRows('feed_source')).toBe(1)
    })

    test('get returns null for an unknown url', async () => {
        expect(await ServerFeedSource.get(db, 'https://nope')).toBeNull()
    })
})

/******************************************************************************
 * ServerFeedFile
 *****************************************************************************/

describe('ServerFeedFile', () => {
    const bucket = env.RSS_CACHE_BUCKET

    async function seedSource() {
        await seedFeed({guid: 'feed-a'})
        await new ServerFeedSource(rawFeedSource('feed-a', {feed_url: 'https://src'})).persistTo(db)
    }

    test('persistTo stores the raw text in R2 and the row in D1', async () => {
        await seedSource()
        const file = new ServerFeedFile({
            feed_url: 'https://src',
            fetched_at: '2024-03-04T05:06:07.000Z',
            referenced_feed: 'feed-a',
            cached_file: 'cached-1.rss',
            sha256_hash: 'hash-1',
        }, '<rss/>')

        await file.persistTo(db, bucket)

        expect(await (await bucket.get('cached-1.rss'))!.text()).toBe('<rss/>')
        const stored = await ServerFeedFile.get(db, 'https://src', new Date('2024-03-04T05:06:07.000Z'))
        expect(stored).toMatchObject({feed_url: 'https://src', cached_file: 'cached-1.rss', sha256_hash: 'hash-1'})
        expect(stored!.fetched_at).toEqual(new Date('2024-03-04T05:06:07.000Z'))
    })

    test('persistTo without raw text skips R2 and ignores conflicts', async () => {
        await seedSource()
        const data = {feed_url: 'https://src', fetched_at: dateAt(1), referenced_feed: 'feed-a', cached_file: 'c.rss', sha256_hash: 'h'}
        await new ServerFeedFile(data, '<rss/>').persistTo(db, bucket)
        await new ServerFeedFile({...data, cached_file: 'other.rss'}).persistTo(db, bucket)

        expect(await bucket.get('other.rss')).toBeNull()
        expect((await ServerFeedFile.getByContentHash(db, 'h'))!.cached_file).toBe('c.rss')
    })

    test('text() returns the in-memory text or reads it from the bucket', async () => {
        const data = {feed_url: 'https://src', fetched_at: dateAt(1), referenced_feed: 'feed-a', cached_file: 'c.rss', sha256_hash: 'h'}

        expect(await new ServerFeedFile(data, '<rss/>').text()).toBe('<rss/>')
        expect(await new ServerFeedFile(data).text()).toBeNull()
        expect(await new ServerFeedFile(data).text(bucket)).toBeNull()

        await bucket.put('c.rss', '<from-bucket/>')
        const file = new ServerFeedFile(data)
        expect(await file.text(bucket)).toBe('<from-bucket/>')
        // cached after the first read
        await bucket.delete('c.rss')
        expect(await file.text(bucket)).toBe('<from-bucket/>')
    })

    test('get and getByContentHash return null when nothing matches', async () => {
        expect(await ServerFeedFile.get(db, 'https://src', new Date())).toBeNull()
        expect(await ServerFeedFile.getByContentHash(db, 'nope')).toBeNull()
    })
})

/******************************************************************************
 * ServerFeedItem
 *****************************************************************************/

describe('ServerFeedItem', () => {
    test('normalises raw values and defaults', () => {
        const item = new ServerFeedItem(rawFeedItem('feed-a', {
            date: '2024-02-03T00:00:00.000Z',
            keywords: 'a, b',
            finished: 1,
            bookmarked: undefined,
            content_hash: undefined,
            encoded_content: null as unknown as string,
        }))

        expect(item.date).toEqual(new Date('2024-02-03T00:00:00.000Z'))
        expect(item.keywords).toEqual(['a', 'b'])
        expect(item.finished).toBe(true)
        expect(item.bookmarked).toBe(false)
        expect(item.content_hash).toBeNull()
        expect(item.encoded_content).toBe('')

        expect(new ServerFeedItem(rawFeedItem('feed-a', {date: null})).date).toBeNull()
    })

    test('persistTo inserts and indexes the plain text of the content', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {
            guid: 'item-a',
            title: 'Title',
            description: 'Desc',
            keywords: 'k1,k2',
            encoded_content: '<p>Hello <b>bold</b> &amp; more</p><script>alert(1)</script>',
        })

        const stored = await ServerFeedItem.get(db, 'item-a')
        expect(stored).toMatchObject({guid: 'item-a', source_feed: 'feed-a', title: 'Title', keywords: ['k1', 'k2']})

        const indexed = await textSearchRow('item-a')
        expect(indexed).toMatchObject({title: 'Title', description: 'Desc', keywords: 'k1,k2', content: 'Hello bold & more', table_name: 'feed_item'})
    })

    test('persistTo updates content but keeps the user state', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a', title: 'Old', finished: true, progress: 42, bookmarked: true})

        await new ServerFeedItem(rawFeedItem('feed-a', {guid: 'item-a', title: 'New', finished: false, progress: 0, bookmarked: false})).persistTo(db)

        const stored = (await ServerFeedItem.get(db, 'item-a'))!
        expect(stored.title).toBe('New')
        expect(stored.finished).toBe(true)
        expect(stored.progress).toBe(42)
        expect(stored.bookmarked).toBe(false)  // bookmarked is not excluded from updates
        expect((await textSearchRow('item-a'))!.title).toBe('New')
    })

    test('refreshTextSearch includes completed transcripts in the content', async () => {
        await seedFeed({guid: 'feed-a'})
        const item = await seedFeedItem('feed-a', {guid: 'item-a', encoded_content: '<p>Body</p>'})
        await db.prepare(`INSERT INTO transcript (feed_item_guid, model, status, text, requested_at) VALUES (?, ?, ?, ?, ?)`)
            .bind('item-a', 'm', 'complete', 'spoken words', dateAt(1)).run()
        await db.prepare(`INSERT INTO transcript (feed_item_guid, model, status, text, requested_at) VALUES (?, ?, ?, ?, ?)`)
            .bind('item-a', 'm', 'pending', 'not yet', dateAt(1)).run()

        await item.refreshTextSearch(db)

        expect((await textSearchRow('item-a'))!.content).toBe('Body\n\nspoken words')
    })

    test('get returns null for an unknown guid', async () => {
        expect(await ServerFeedItem.get(db, 'nope')).toBeNull()
    })
})

describe('getCombinedTextSearchContent', () => {
    test('returns the stripped content when there are no transcripts', async () => {
        expect(await getCombinedTextSearchContent(db, 'item-a', '<p>Hi</p>')).toBe('Hi')
    })

    test('joins the content and every completed transcript, skipping empties', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        for (const [status, text] of [['complete', 'one'], ['complete', 'two'], ['complete', null], ['error', 'three']] as const) {
            await db.prepare(`INSERT INTO transcript (feed_item_guid, model, status, text, requested_at) VALUES (?, ?, ?, ?, ?)`)
                .bind('item-a', 'm', status, text, dateAt(1)).run()
        }

        expect(await getCombinedTextSearchContent(db, 'item-a', '')).toBe('one\n\ntwo')
    })
})

describe('ClientFeedItemPreview / ClientFeedItem', () => {
    test('the preview omits encoded_content and the full item includes it', () => {
        const item = new ServerFeedItem(rawFeedItem('feed-a', {guid: 'item-a', encoded_content: '<p>x</p>', keywords: 'a', content_hash: 'h'}))

        const preview = new ClientFeedItemPreview(item)
        expect(preview).not.toHaveProperty('encoded_content')
        expect(preview).not.toHaveProperty('content_hash')
        expect(preview).toMatchObject({guid: 'item-a', keywords: ['a'], date: item.date, finished: false, bookmarked: false})

        const full = new ClientFeedItem(item)
        expect(full).toBeInstanceOf(ClientFeedItemPreview)
        expect(full.encoded_content).toBe('<p>x</p>')
    })
})

/******************************************************************************
 * ServerNotification
 *****************************************************************************/

describe('ServerNotification', () => {
    test('persistTo inserts with an auto-assigned id', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})

        const notification = new ServerNotification({
            type: 'new_item', feed_guid: 'feed-a', feed_item_guid: 'item-a', created_at: '2024-01-01T00:00:00.000Z', dismissed: 0,
        })
        expect(notification.id).toBeNull()
        expect(notification.dismissed).toBe(false)
        await notification.persistTo(db)

        const rows = await db.prepare('SELECT * FROM notification').all<{id: number, type: string, dismissed: number}>()
        expect(rows.results).toEqual([expect.objectContaining({id: 1, type: 'new_item', dismissed: 0})])
    })

    test('keeps an explicit id and defaults dismissed', () => {
        const notification = new ServerNotification({id: 7, type: 'updated_item', feed_guid: 'f', feed_item_guid: 'i', created_at: new Date(0), dismissed: undefined as unknown as number})
        expect(notification.id).toBe(7)
        expect(notification.dismissed).toBe(false)
        expect(notification.created_at).toEqual(new Date(0))
    })
})

/******************************************************************************
 * ServerTranscript
 *****************************************************************************/

describe('ServerTranscript', () => {
    const raw: RawTranscript = {
        id: 1,
        feed_item_guid: 'item-a',
        model: 'whisper',
        language: 'en',
        source_transcript_id: null,
        status: 'processing',
        text: 'hello',
        segments_json: '[]',
        error_message: null,
        batch_request_id: 'req-1',
        requested_at: '2024-01-01T00:00:00.000Z',
        started_at: '2024-01-01T00:01:00.000Z',
        completed_at: null,
    }

    test('normalises dates', () => {
        const transcript = new ServerTranscript(raw)
        expect(transcript.requested_at).toEqual(new Date('2024-01-01T00:00:00.000Z'))
        expect(transcript.started_at).toEqual(new Date('2024-01-01T00:01:00.000Z'))
        expect(transcript.completed_at).toBeNull()
    })

    test('get reads a row by id', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        await db.prepare(`INSERT INTO transcript (feed_item_guid, model, status, requested_at) VALUES (?, ?, ?, ?)`)
            .bind('item-a', 'whisper', 'pending', dateAt(1)).run()

        const transcript = await ServerTranscript.get(db, 1)
        expect(transcript).toMatchObject({id: 1, feed_item_guid: 'item-a', model: 'whisper', status: 'pending', language: null, started_at: null})
        expect(await ServerTranscript.get(db, 2)).toBeNull()
    })

    test('client views hide or expose the transcript body', () => {
        const transcript = new ServerTranscript(raw)

        const summary = new ClientTranscript(transcript)
        expect(summary).not.toHaveProperty('text')
        expect(summary).not.toHaveProperty('segments_json')
        expect(summary).not.toHaveProperty('batch_request_id')
        expect(summary).toMatchObject({id: 1, status: 'processing', language: 'en', requested_at: transcript.requested_at})

        const full = new ClientTranscriptFull(transcript)
        expect(full).toBeInstanceOf(ClientTranscript)
        expect(full.text).toBe('hello')
        expect(full.segments_json).toBe('[]')
    })
})

/******************************************************************************
 * ServerPushSubscription
 *****************************************************************************/

describe('ServerPushSubscription', () => {
    test('persistTo inserts, and re-subscribing updates the keys but not created_at', async () => {
        await new ServerPushSubscription({endpoint: 'https://push/1', p256dh: 'p1', auth: 'a1', created_at: dateAt(1), last_used_at: null}).persistTo(db)
        await new ServerPushSubscription({endpoint: 'https://push/1', p256dh: 'p2', auth: 'a2', created_at: dateAt(2), last_used_at: dateAt(3)}).persistTo(db)

        const rows = await db.prepare('SELECT * FROM push_subscription').all<{endpoint: string, p256dh: string, auth: string, created_at: string, last_used_at: string | null}>()
        expect(rows.results).toEqual([{endpoint: 'https://push/1', p256dh: 'p2', auth: 'a2', created_at: dateAt(1), last_used_at: dateAt(3)}])
    })

    test('normalises dates', () => {
        const sub = new ServerPushSubscription({endpoint: 'e', p256dh: 'p', auth: 'a', created_at: dateAt(1), last_used_at: null})
        expect(sub.created_at).toEqual(new Date(dateAt(1)))
        expect(sub.last_used_at).toBeNull()
    })
})
