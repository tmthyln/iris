import {env} from 'cloudflare:workers'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {
    countPushSubscriptions,
    createFeed,
    createFeedFile,
    createFeedItem,
    createFeedSource,
    createNotification,
    createTranscriptRequest,
    deletePushSubscription,
    dismissAllNotifications,
    dismissNotification,
    getActiveTranscriptRequest,
    getAdjacentFeedItems,
    getAllPushSubscriptions,
    getBookmarkedFeedItems,
    getFeedFilesForFeed,
    getFeedItemDateRange,
    getFeedItemFingerprintsByGuids,
    getFeedItems,
    getFeedItemsForFeed,
    getFeedMaxItemDate,
    getFeeds,
    getNotifications,
    getUnreadNotificationCount,
    getUpdatableFeedSources,
    listTranscriptsForItem,
    searchFeedItems,
    touchPushSubscription,
    updateTranscriptStatus,
    upsertPushSubscription,
} from './crud'
import {ServerFeed, ServerFeedFile, ServerFeedItem, ServerFeedSource, ServerPushSubscription, ServerTranscript} from './models'
import {type FetchSuccessFileResult} from './types'
import {type ChannelData, type ChannelItemData, computeFeedItemContentHash, sha256Encode} from './utils/files'
import {countRows, dateAt, rawFeedItem, resetStorage, seedFeed, seedFeedItem, seedFeedSource} from './testing/fixtures'

const db = env.DB

beforeEach(() => resetStorage())
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const guids = (items: {guid: string}[]) => items.map(item => item.guid)

async function insertTranscript(feedItemGuid: string, fields: {model?: string, status?: string, requested_at?: string, language?: string | null} = {}) {
    const {model = 'whisper', status = 'pending', requested_at = dateAt(1), language = null} = fields
    const result = await db
        .prepare('INSERT INTO transcript (feed_item_guid, model, language, status, requested_at) VALUES (?, ?, ?, ?, ?)')
        .bind(feedItemGuid, model, language, status, requested_at)
        .run()
    return result.meta.last_row_id
}

async function insertNotification(feedGuid: string, feedItemGuid: string, fields: {type?: string, created_at?: string, dismissed?: boolean} = {}) {
    const {type = 'new_item', created_at = dateAt(1), dismissed = false} = fields
    const result = await db
        .prepare('INSERT INTO notification (type, feed_guid, feed_item_guid, created_at, dismissed) VALUES (?, ?, ?, ?, ?)')
        .bind(type, feedGuid, feedItemGuid, created_at, dismissed)
        .run()
    return result.meta.last_row_id
}

/******************************************************************************
 * getAdjacentFeedItems
 *****************************************************************************/

describe('getAdjacentFeedItems', () => {
    test('returns nulls for an unknown guid', async () => {
        expect(await getAdjacentFeedItems(db, 'nope')).toEqual({prev: null, next: null})
    })

    test('returns nulls for an item without a date', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'undated', date: null})
        await seedFeedItem('feed-a', {guid: 'dated', date: dateAt(5)})

        expect(await getAdjacentFeedItems(db, 'undated')).toEqual({prev: null, next: null})
    })

    test('finds the previous and next items by date within the same feed', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b'})
        await seedFeedItem('feed-a', {guid: 'first', date: dateAt(1)})
        await seedFeedItem('feed-a', {guid: 'middle', date: dateAt(2)})
        await seedFeedItem('feed-a', {guid: 'last', date: dateAt(3)})
        // other feed's items, dated between ours, must not be picked
        await seedFeedItem('feed-b', {guid: 'other-1', date: dateAt(1.5)})
        await seedFeedItem('feed-b', {guid: 'other-2', date: dateAt(2.5)})

        const middle = await getAdjacentFeedItems(db, 'middle')
        expect(middle.prev).toBeInstanceOf(ServerFeedItem)
        expect(middle.prev!.guid).toBe('first')
        expect(middle.next!.guid).toBe('last')

        const first = await getAdjacentFeedItems(db, 'first')
        expect(first.prev).toBeNull()
        expect(first.next!.guid).toBe('middle')

        const last = await getAdjacentFeedItems(db, 'last')
        expect(last.prev!.guid).toBe('middle')
        expect(last.next).toBeNull()
    })

    test('picks the nearest items when several exist on each side', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'd1', date: dateAt(1)})
        await seedFeedItem('feed-a', {guid: 'd2', date: dateAt(2)})
        await seedFeedItem('feed-a', {guid: 'd3', date: dateAt(3)})
        await seedFeedItem('feed-a', {guid: 'd4', date: dateAt(4)})
        await seedFeedItem('feed-a', {guid: 'd5', date: dateAt(5)})

        const result = await getAdjacentFeedItems(db, 'd3')
        expect(result.prev!.guid).toBe('d2')
        expect(result.next!.guid).toBe('d4')
    })
})

/******************************************************************************
 * searchFeedItems
 *****************************************************************************/

describe('searchFeedItems', () => {
    test('returns an empty list when nothing matches', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {title: 'Quantum computing'})

        expect(await searchFeedItems(db, 'gardening')).toEqual([])
    })

    test('matches on title, description and stripped content', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'by-title', title: 'Kubernetes basics', description: 'x', encoded_content: ''})
        await seedFeedItem('feed-a', {guid: 'by-description', title: 'x', description: 'All about kubernetes', encoded_content: ''})
        await seedFeedItem('feed-a', {guid: 'by-content', title: 'x', description: 'x', encoded_content: '<p>Deploying <b>Kubernetes</b> clusters</p>'})
        await seedFeedItem('feed-a', {guid: 'unrelated', title: 'Cooking', description: 'Soup', encoded_content: '<p>Broth</p>'})

        const results = await searchFeedItems(db, 'kubernetes')
        expect(results[0]).toBeInstanceOf(ServerFeedItem)
        expect(guids(results).sort()).toEqual(['by-content', 'by-description', 'by-title'])
    })

    test('does not match HTML markup that was stripped from the content', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'html', title: 'x', description: 'x', encoded_content: '<strong>plain words</strong>'})

        expect(await searchFeedItems(db, 'strong')).toEqual([])
        expect(guids(await searchFeedItems(db, 'plain words'))).toEqual(['html'])
    })

    test('escapes double quotes in the query', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'quoted', title: 'He said "hello" loudly'})

        expect(guids(await searchFeedItems(db, '"hello"'))).toEqual(['quoted'])
        expect(await searchFeedItems(db, '"nothing"')).toEqual([])
    })

    test('applies limit and offset', async () => {
        await seedFeed({guid: 'feed-a'})
        for (let i = 0; i < 5; i++) {
            await seedFeedItem('feed-a', {guid: `match-${i}`, title: 'shared keyword'})
        }

        const all = await searchFeedItems(db, 'shared keyword')
        expect(all).toHaveLength(5)

        const limited = await searchFeedItems(db, 'shared keyword', {limit: 2})
        expect(limited).toHaveLength(2)

        const rest = await searchFeedItems(db, 'shared keyword', {limit: 10, offset: 3})
        expect(rest).toHaveLength(2)
        expect(guids(rest)).toEqual(guids(all).slice(3))
    })
})

/******************************************************************************
 * getFeeds
 *****************************************************************************/

describe('getFeeds', () => {
    test('returns only active feeds', async () => {
        await seedFeed({guid: 'active', active: true})
        await seedFeed({guid: 'inactive', active: false})

        const feeds = await getFeeds(db)
        expect(feeds[0]).toBeInstanceOf(ServerFeed)
        expect(guids(feeds)).toEqual(['active'])
    })

    test('reports has_unread from the feed items', async () => {
        await seedFeed({guid: 'no-items'})
        await seedFeed({guid: 'all-finished'})
        await seedFeedItem('all-finished', {finished: true})
        await seedFeedItem('all-finished', {finished: true})
        await seedFeed({guid: 'one-unread'})
        await seedFeedItem('one-unread', {finished: true})
        await seedFeedItem('one-unread', {finished: false})

        const unread = Object.fromEntries((await getFeeds(db)).map(feed => [feed.guid, feed.has_unread]))
        expect(unread).toEqual({'no-items': false, 'all-finished': false, 'one-unread': true})
    })

    test('reports has_archives from the feed sources', async () => {
        await seedFeed({guid: 'plain'})
        await seedFeedSource('plain', {archive: false})
        await seedFeed({guid: 'archived'})
        await seedFeedSource('archived', {archive: false})
        await seedFeedSource('archived', {archive: true})

        const archives = Object.fromEntries((await getFeeds(db)).map(feed => [feed.guid, feed.has_archives]))
        expect(archives).toEqual({plain: false, archived: true})
    })

    test('orders feeds by their newest item, feeds without items last', async () => {
        await seedFeed({guid: 'empty'})
        await seedFeed({guid: 'old'})
        await seedFeedItem('old', {date: dateAt(1)})
        await seedFeedItem('old', {date: dateAt(2)})
        await seedFeed({guid: 'new'})
        await seedFeedItem('new', {date: dateAt(10)})
        await seedFeed({guid: 'middle'})
        await seedFeedItem('middle', {date: dateAt(5)})

        expect(guids(await getFeeds(db))).toEqual(['new', 'middle', 'old', 'empty'])
    })

    test('returns one row per feed even with many items', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a')
        await seedFeedItem('feed-a')
        await seedFeedItem('feed-a')

        expect(await getFeeds(db)).toHaveLength(1)
    })
})

/******************************************************************************
 * getUpdatableFeedSources
 *****************************************************************************/

describe('getUpdatableFeedSources', () => {
    test('returns only live, actively updating sources of the feed', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b'})
        await seedFeedSource('feed-a', {feed_url: 'https://a/live', actively_updating: true, archive: false})
        await seedFeedSource('feed-a', {feed_url: 'https://a/archive', actively_updating: true, archive: true})
        await seedFeedSource('feed-a', {feed_url: 'https://a/stale', actively_updating: false, archive: false})
        await seedFeedSource('feed-b', {feed_url: 'https://b/live', actively_updating: true, archive: false})

        const sources = await getUpdatableFeedSources(db, 'feed-a')
        expect(sources[0]).toBeInstanceOf(ServerFeedSource)
        expect(sources.map(source => source.feed_url)).toEqual(['https://a/live'])
    })

    test('returns an empty list for an unknown feed', async () => {
        expect(await getUpdatableFeedSources(db, 'nope')).toEqual([])
    })
})

/******************************************************************************
 * getFeedItems
 *****************************************************************************/

describe('getFeedItems', () => {
    test('returns unfinished items of active feeds, newest first', async () => {
        await seedFeed({guid: 'active', active: true})
        await seedFeed({guid: 'inactive', active: false})
        await seedFeedItem('active', {guid: 'old', date: dateAt(1)})
        await seedFeedItem('active', {guid: 'new', date: dateAt(3)})
        await seedFeedItem('active', {guid: 'done', date: dateAt(2), finished: true})
        await seedFeedItem('inactive', {guid: 'hidden', date: dateAt(4)})

        const items = await getFeedItems(db)
        expect(items[0]).toBeInstanceOf(ServerFeedItem)
        expect(guids(items)).toEqual(['new', 'old'])
    })

    test('supports ascending order', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'old', date: dateAt(1)})
        await seedFeedItem('feed-a', {guid: 'new', date: dateAt(2)})

        expect(guids(await getFeedItems(db, {sortOrder: 'asc'}))).toEqual(['old', 'new'])
    })

    test('applies limit and offset', async () => {
        await seedFeed({guid: 'feed-a'})
        for (let i = 1; i <= 5; i++) {
            await seedFeedItem('feed-a', {guid: `i${i}`, date: dateAt(i)})
        }

        expect(guids(await getFeedItems(db, {limit: 2}))).toEqual(['i5', 'i4'])
        expect(guids(await getFeedItems(db, {limit: 2, offset: 2}))).toEqual(['i3', 'i2'])
        expect(guids(await getFeedItems(db, {offset: 4}))).toEqual(['i1'])
    })
})

/******************************************************************************
 * getFeedItemsForFeed
 *****************************************************************************/

describe('getFeedItemsForFeed', () => {
    test('returns the feed\'s unfinished items oldest first by default', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b'})
        await seedFeedItem('feed-a', {guid: 'new', date: dateAt(3)})
        await seedFeedItem('feed-a', {guid: 'old', date: dateAt(1)})
        await seedFeedItem('feed-a', {guid: 'done', date: dateAt(2), finished: true})
        await seedFeedItem('feed-b', {guid: 'other', date: dateAt(0)})

        const items = await getFeedItemsForFeed(db, 'feed-a')
        expect(items[0]).toBeInstanceOf(ServerFeedItem)
        expect(guids(items)).toEqual(['old', 'new'])
    })

    test('includes finished items on request', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'open', date: dateAt(1)})
        await seedFeedItem('feed-a', {guid: 'done', date: dateAt(2), finished: true})

        expect(guids(await getFeedItemsForFeed(db, 'feed-a', {includeFinished: true}))).toEqual(['open', 'done'])
    })

    test('supports descending order', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'old', date: dateAt(1)})
        await seedFeedItem('feed-a', {guid: 'new', date: dateAt(2)})

        expect(guids(await getFeedItemsForFeed(db, 'feed-a', {sortOrder: 'desc'}))).toEqual(['new', 'old'])
    })

    test('applies limit and offset', async () => {
        await seedFeed({guid: 'feed-a'})
        for (let i = 1; i <= 5; i++) {
            await seedFeedItem('feed-a', {guid: `i${i}`, date: dateAt(i)})
        }

        expect(guids(await getFeedItemsForFeed(db, 'feed-a', {limit: 2}))).toEqual(['i1', 'i2'])
        expect(guids(await getFeedItemsForFeed(db, 'feed-a', {limit: 2, offset: 2}))).toEqual(['i3', 'i4'])
        expect(guids(await getFeedItemsForFeed(db, 'feed-a', {offset: 4}))).toEqual(['i5'])
    })

    test('returns an empty list for an unknown feed', async () => {
        expect(await getFeedItemsForFeed(db, 'nope')).toEqual([])
    })
})

/******************************************************************************
 * getFeedFilesForFeed
 *****************************************************************************/

describe('getFeedFilesForFeed', () => {
    async function insertFile(feedUrl: string, feedGuid: string, fetchedAt: string, hash: string) {
        await new ServerFeedFile({
            feed_url: feedUrl, fetched_at: fetchedAt, referenced_feed: feedGuid, cached_file: `${hash}.rss`, sha256_hash: hash,
        }).persistTo(db, env.RSS_CACHE_BUCKET)
    }

    test('returns the feed\'s files oldest first', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b'})
        await seedFeedSource('feed-a', {feed_url: 'https://a/rss'})
        await seedFeedSource('feed-b', {feed_url: 'https://b/rss'})
        await insertFile('https://a/rss', 'feed-a', dateAt(3), 'h3')
        await insertFile('https://a/rss', 'feed-a', dateAt(1), 'h1')
        await insertFile('https://a/rss', 'feed-a', dateAt(2), 'h2')
        await insertFile('https://b/rss', 'feed-b', dateAt(0), 'hb')

        const files = await getFeedFilesForFeed(db, 'feed-a')
        expect(files[0]).toBeInstanceOf(ServerFeedFile)
        expect(files.map(file => file.sha256_hash)).toEqual(['h1', 'h2', 'h3'])
        expect(files.map(file => file.fetched_at)).toEqual([new Date(dateAt(1)), new Date(dateAt(2)), new Date(dateAt(3))])
    })

    test('returns an empty list for a feed without files', async () => {
        await seedFeed({guid: 'feed-a'})
        expect(await getFeedFilesForFeed(db, 'feed-a')).toEqual([])
    })
})

/******************************************************************************
 * getFeedMaxItemDate
 *****************************************************************************/

describe('getFeedMaxItemDate', () => {
    test('returns null when the feed has no dated items', async () => {
        await seedFeed({guid: 'feed-a'})
        expect(await getFeedMaxItemDate(db, 'feed-a')).toBeNull()

        await seedFeedItem('feed-a', {date: null})
        expect(await getFeedMaxItemDate(db, 'feed-a')).toBeNull()
    })

    test('returns the latest item date of the feed', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b'})
        await seedFeedItem('feed-a', {date: dateAt(2)})
        await seedFeedItem('feed-a', {date: dateAt(5)})
        await seedFeedItem('feed-a', {date: dateAt(1)})
        await seedFeedItem('feed-a', {date: null})
        await seedFeedItem('feed-b', {date: dateAt(9)})

        expect(await getFeedMaxItemDate(db, 'feed-a')).toEqual(new Date(dateAt(5)))
    })
})

/******************************************************************************
 * getFeedItemFingerprintsByGuids
 *****************************************************************************/

describe('getFeedItemFingerprintsByGuids', () => {
    test('returns an empty map for no guids without touching the database', async () => {
        const prepare = vi.spyOn(db, 'prepare')
        const fingerprints = await getFeedItemFingerprintsByGuids(db, 'feed-a', [])
        expect(fingerprints.size).toBe(0)
        expect(prepare).not.toHaveBeenCalled()
    })

    test('returns fingerprints only for guids that exist in the feed', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b'})
        await seedFeedItem('feed-a', {guid: 'known', date: dateAt(3), content_hash: 'hash-known'})
        await seedFeedItem('feed-a', {guid: 'bare', date: null, content_hash: null})
        await seedFeedItem('feed-b', {guid: 'elsewhere', date: dateAt(1), content_hash: 'hash-elsewhere'})

        const fingerprints = await getFeedItemFingerprintsByGuids(db, 'feed-a', ['known', 'bare', 'elsewhere', 'missing'])
        expect([...fingerprints.keys()].sort()).toEqual(['bare', 'known'])
        expect(fingerprints.get('known')).toEqual({date: new Date(dateAt(3)), content_hash: 'hash-known'})
        expect(fingerprints.get('bare')).toEqual({date: null, content_hash: null})
    })

    test("chunks the IN-list under D1's 100-parameter limit", async () => {
        // Each chunk binds source_feed plus up to 99 guids; 250 guids span three chunks.
        await seedFeed({guid: 'feed-a'})
        const total = 200
        await db.batch(Array.from({length: total}, (_, i) => {
            const raw = rawFeedItem('feed-a', {guid: `bulk-${i}`, date: dateAt(i), content_hash: `hash-${i}`})
            return db
                .prepare(`INSERT INTO feed_item (guid, source_feed, title, link, date, encoded_content, keywords, finished, progress, bookmarked, content_hash)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .bind(raw.guid, raw.source_feed, raw.title, raw.link, raw.date, raw.encoded_content, raw.keywords, 0, 0, 0, raw.content_hash)
        }))

        const requested = Array.from({length: 250}, (_, i) => `bulk-${i}`)
        const fingerprints = await getFeedItemFingerprintsByGuids(db, 'feed-a', requested)
        expect(fingerprints.size).toBe(total)
        expect(fingerprints.get('bulk-0')).toEqual({date: new Date(dateAt(0)), content_hash: 'hash-0'})
        expect(fingerprints.get(`bulk-${total - 1}`)).toEqual({date: new Date(dateAt(total - 1)), content_hash: `hash-${total - 1}`})
        expect(fingerprints.has(`bulk-${total}`)).toBe(false)
    })
})

/******************************************************************************
 * getFeedItemDateRange
 *****************************************************************************/

describe('getFeedItemDateRange', () => {
    test('returns null when the feed has no dated items', async () => {
        await seedFeed({guid: 'feed-a'})
        expect(await getFeedItemDateRange(db, 'feed-a')).toBeNull()

        await seedFeedItem('feed-a', {date: null})
        expect(await getFeedItemDateRange(db, 'feed-a')).toBeNull()
    })

    test('returns the earliest and latest item dates of the feed', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b'})
        await seedFeedItem('feed-a', {date: dateAt(4)})
        await seedFeedItem('feed-a', {date: dateAt(2)})
        await seedFeedItem('feed-a', {date: dateAt(7)})
        await seedFeedItem('feed-a', {date: null})
        await seedFeedItem('feed-b', {date: dateAt(0)})
        await seedFeedItem('feed-b', {date: dateAt(20)})

        expect(await getFeedItemDateRange(db, 'feed-a')).toEqual({earliest: new Date(dateAt(2)), latest: new Date(dateAt(7))})
    })

    test('a single dated item is both ends of the range', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {date: dateAt(3)})

        expect(await getFeedItemDateRange(db, 'feed-a')).toEqual({earliest: new Date(dateAt(3)), latest: new Date(dateAt(3))})
    })
})

/******************************************************************************
 * getBookmarkedFeedItems
 *****************************************************************************/

describe('getBookmarkedFeedItems', () => {
    test('returns bookmarked items across feeds, finished or not', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b', active: false})
        await seedFeedItem('feed-a', {guid: 'marked', bookmarked: true})
        await seedFeedItem('feed-a', {guid: 'marked-done', bookmarked: true, finished: true})
        await seedFeedItem('feed-a', {guid: 'plain', bookmarked: false})
        await seedFeedItem('feed-b', {guid: 'marked-inactive', bookmarked: true})

        const items = await getBookmarkedFeedItems(db)
        expect(items[0]).toBeInstanceOf(ServerFeedItem)
        expect(guids(items).sort()).toEqual(['marked', 'marked-done', 'marked-inactive'])
    })

    test('returns an empty list when nothing is bookmarked', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a')
        expect(await getBookmarkedFeedItems(db)).toEqual([])
    })
})

/******************************************************************************
 * Entity factories
 *****************************************************************************/

const channel: ChannelData = {
    guid: 'channel-guid',
    source_url: 'https://example.com/rss',
    title: 'Channel title',
    description: 'Channel description',
    author: 'Channel author',
    type: 'podcast',
    image_src: 'https://example.com/cover.jpg',
    image_alt: 'Cover',
    last_updated: '2024-02-03T04:05:06.000Z',
    link: 'https://example.com',
    categories: '',
}

const fetchResult: FetchSuccessFileResult = {
    status: 'success',
    content: '<rss/>',
    metadata: {
        timestamp: '2024-05-06T07:08:09.000Z',
        requestUrl: 'https://example.com/rss?x=1',
        sha256Hash: 'content-hash',
    },
}

const channelItem: ChannelItemData = {
    guid: 'channel-item',
    season: 2,
    episode: 7,
    title: 'Episode title',
    description: 'Episode description',
    link: 'https://example.com/episode',
    date: '2024-03-04T00:00:00.000Z',
    enclosure_url: 'https://example.com/episode.mp3',
    enclosure_length: 1234,
    enclosure_type: 'audio/mpeg',
    duration: 3600,
    duration_unit: 'seconds',
    encoded_content: '<p>Show notes</p>',
    keywords: 'a,b',
}

describe('createFeed', () => {
    test('builds a new, active, ongoing feed from channel data', () => {
        const feed = createFeed(channel, fetchResult, 'https://example.com')

        expect(feed).toBeInstanceOf(ServerFeed)
        expect(feed).toMatchObject({
            guid: 'channel-guid',
            input_url: 'https://example.com',
            source_url: 'https://example.com/rss',
            title: 'Channel title',
            alias: '',
            description: 'Channel description',
            author: 'Channel author',
            type: 'podcast',
            ongoing: true,
            active: true,
            image_src: 'https://example.com/cover.jpg',
            image_alt: 'Cover',
            update_frequency: 1,
            link: 'https://example.com',
            categories: [],
            notify_enabled: false,
        })
        expect(feed.last_updated).toEqual(new Date('2024-02-03T04:05:06.000Z'))
    })
})

describe('createFeedSource', () => {
    test('links the fetched URL to the feed as a live, non-primary source', () => {
        const feed = createFeed(channel, fetchResult, 'https://example.com')
        const source = createFeedSource(feed, channel, fetchResult)

        expect(source).toBeInstanceOf(ServerFeedSource)
        expect(source).toMatchObject({
            feed_url: 'https://example.com/rss?x=1',
            referenced_feed: 'channel-guid',
            actively_updating: true,
            archive: false,
            primary_source: false,
        })
        expect(source.last_updated).toEqual(new Date('2024-02-03T04:05:06.000Z'))
        expect(source.last_fetched).toEqual(new Date('2024-05-06T07:08:09.000Z'))
    })
})

describe('createFeedFile', () => {
    test('names the cached file after the URL hash and fetch time, keeping the raw text', async () => {
        const feed = createFeed(channel, fetchResult, 'https://example.com')
        const source = createFeedSource(feed, channel, fetchResult)

        const file = await createFeedFile(source, fetchResult)

        expect(file).toBeInstanceOf(ServerFeedFile)
        const urlHash = await sha256Encode('https://example.com/rss?x=1')
        expect(file.cached_file).toBe(`cached-file-${urlHash}-${new Date('2024-05-06T07:08:09.000Z').getTime()}.rss`)
        expect(file).toMatchObject({
            feed_url: 'https://example.com/rss?x=1',
            referenced_feed: 'channel-guid',
            sha256_hash: 'content-hash',
        })
        expect(file.fetched_at).toEqual(new Date('2024-05-06T07:08:09.000Z'))
        expect(await file.text()).toBe('<rss/>')
    })
})

describe('createFeedItem', () => {
    test('copies the channel item into a fresh, unplayed feed item', async () => {
        const feed = createFeed(channel, fetchResult, 'https://example.com')
        const item = await createFeedItem(feed, channelItem)

        expect(item).toBeInstanceOf(ServerFeedItem)
        expect(item).toMatchObject({
            guid: 'channel-item',
            source_feed: 'channel-guid',
            season: 2,
            episode: 7,
            title: 'Episode title',
            enclosure_url: 'https://example.com/episode.mp3',
            duration: 3600,
            keywords: ['a', 'b'],
            finished: false,
            progress: 0,
            bookmarked: false,
        })
        expect(item.date).toEqual(new Date('2024-03-04T00:00:00.000Z'))
    })

    test('computes the content hash unless one is supplied', async () => {
        const feed = createFeed(channel, fetchResult, 'https://example.com')

        const computed = await createFeedItem(feed, channelItem)
        expect(computed.content_hash).toBe(await computeFeedItemContentHash(channelItem))

        const explicit = await createFeedItem(feed, channelItem, 'given-hash')
        expect(explicit.content_hash).toBe('given-hash')
    })
})

/******************************************************************************
 * Notifications
 *****************************************************************************/

describe('createNotification', () => {
    test('inserts an undismissed notification stamped with the current time', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2024-06-07T08:09:10.000Z'))
        try {
            await seedFeed({guid: 'feed-a'})
            await seedFeedItem('feed-a', {guid: 'item-a'})

            const notification = await createNotification(db, 'updated_item', 'feed-a', 'item-a')
            expect(notification).toMatchObject({type: 'updated_item', feed_guid: 'feed-a', feed_item_guid: 'item-a', dismissed: false})
            expect(notification.created_at).toEqual(new Date('2024-06-07T08:09:10.000Z'))

            const rows = await db.prepare('SELECT * FROM notification').all<{type: string, created_at: string, dismissed: number}>()
            expect(rows.results).toEqual([expect.objectContaining({type: 'updated_item', created_at: '2024-06-07T08:09:10.000Z', dismissed: 0})])
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('getNotifications', () => {
    test('joins the feed and item titles into client notifications', async () => {
        await seedFeed({guid: 'feed-a', title: 'Feed title', alias: 'Feed alias'})
        await seedFeedItem('feed-a', {guid: 'item-a', title: 'Item title'})
        const id = await insertNotification('feed-a', 'item-a', {type: 'new_item', created_at: '2024-01-02T00:00:00.000Z'})

        expect(await getNotifications(db)).toEqual([{
            id,
            type: 'new_item',
            feed_guid: 'feed-a',
            feed_item_guid: 'item-a',
            feed_title: 'Feed title',
            feed_alias: 'Feed alias',
            item_title: 'Item title',
            created_at: '2024-01-02T00:00:00.000Z',
            dismissed: false,
        }])
    })

    test('excludes dismissed notifications unless asked for', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        const open = await insertNotification('feed-a', 'item-a', {dismissed: false, created_at: dateAt(2)})
        const dismissed = await insertNotification('feed-a', 'item-a', {dismissed: true, created_at: dateAt(1)})

        expect((await getNotifications(db)).map(n => n.id)).toEqual([open])

        const all = await getNotifications(db, {includeDismissed: true})
        expect(all.map(n => [n.id, n.dismissed])).toEqual([[open, false], [dismissed, true]])
    })

    test('orders newest first and applies the limit', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        const first = await insertNotification('feed-a', 'item-a', {created_at: dateAt(1)})
        const third = await insertNotification('feed-a', 'item-a', {created_at: dateAt(3)})
        const second = await insertNotification('feed-a', 'item-a', {created_at: dateAt(2)})

        expect((await getNotifications(db)).map(n => n.id)).toEqual([third, second, first])
        expect((await getNotifications(db, {limit: 2})).map(n => n.id)).toEqual([third, second])
    })

    test('returns an empty list when there are no notifications', async () => {
        expect(await getNotifications(db)).toEqual([])
    })
})

describe('getUnreadNotificationCount', () => {
    test('counts only undismissed notifications', async () => {
        expect(await getUnreadNotificationCount(db)).toBe(0)

        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        await insertNotification('feed-a', 'item-a', {dismissed: false})
        await insertNotification('feed-a', 'item-a', {dismissed: false})
        await insertNotification('feed-a', 'item-a', {dismissed: true})

        expect(await getUnreadNotificationCount(db)).toBe(2)
    })
})

describe('dismissNotification', () => {
    test('dismisses just the given notification', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        const target = await insertNotification('feed-a', 'item-a')
        const other = await insertNotification('feed-a', 'item-a')

        await dismissNotification(db, target)

        const all = await getNotifications(db, {includeDismissed: true})
        expect(Object.fromEntries(all.map(n => [n.id, n.dismissed]))).toEqual({[target]: true, [other]: false})
    })

    test('is a no-op for an unknown id', async () => {
        await expect(dismissNotification(db, 999)).resolves.toBeUndefined()
    })
})

describe('dismissAllNotifications', () => {
    test('dismisses every open notification', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        await insertNotification('feed-a', 'item-a')
        await insertNotification('feed-a', 'item-a')
        await insertNotification('feed-a', 'item-a', {dismissed: true})

        await dismissAllNotifications(db)

        expect(await getUnreadNotificationCount(db)).toBe(0)
        expect(await getNotifications(db, {includeDismissed: true})).toHaveLength(3)
    })
})

/******************************************************************************
 * Transcripts
 *****************************************************************************/

describe('getActiveTranscriptRequest', () => {
    beforeEach(async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        await seedFeedItem('feed-a', {guid: 'item-b'})
    })

    test('returns null when there is no pending or processing request', async () => {
        expect(await getActiveTranscriptRequest(db, 'item-a', 'whisper')).toBeNull()

        await insertTranscript('item-a', {status: 'complete'})
        await insertTranscript('item-a', {status: 'error'})
        expect(await getActiveTranscriptRequest(db, 'item-a', 'whisper')).toBeNull()
    })

    test('finds pending and processing requests for the item and model only', async () => {
        const pending = await insertTranscript('item-a', {status: 'pending'})
        await insertTranscript('item-a', {status: 'processing', model: 'other-model'})
        await insertTranscript('item-b', {status: 'processing'})

        const active = await getActiveTranscriptRequest(db, 'item-a', 'whisper')
        expect(active).toBeInstanceOf(ServerTranscript)
        expect(active!.id).toBe(pending)

        expect((await getActiveTranscriptRequest(db, 'item-a', 'other-model'))!.status).toBe('processing')
        expect(await getActiveTranscriptRequest(db, 'item-b', 'other-model')).toBeNull()
    })

    test('returns the most recently requested active request', async () => {
        await insertTranscript('item-a', {status: 'pending', requested_at: dateAt(1)})
        const latest = await insertTranscript('item-a', {status: 'processing', requested_at: dateAt(3)})
        await insertTranscript('item-a', {status: 'pending', requested_at: dateAt(2)})

        expect((await getActiveTranscriptRequest(db, 'item-a', 'whisper'))!.id).toBe(latest)
    })
})

describe('createTranscriptRequest', () => {
    test('inserts a pending request and returns it', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2024-06-07T08:09:10.000Z'))
        try {
            await seedFeed({guid: 'feed-a'})
            await seedFeedItem('feed-a', {guid: 'item-a'})

            const transcript = await createTranscriptRequest(db, 'item-a', 'whisper', 'en')
            expect(transcript).toBeInstanceOf(ServerTranscript)
            expect(transcript).toMatchObject({
                feed_item_guid: 'item-a',
                model: 'whisper',
                language: 'en',
                status: 'pending',
                text: null,
                batch_request_id: null,
                started_at: null,
                completed_at: null,
            })
            expect(transcript.requested_at).toEqual(new Date('2024-06-07T08:09:10.000Z'))
            expect(await ServerTranscript.get(db, transcript.id)).toEqual(transcript)
        } finally {
            vi.useRealTimers()
        }
    })

    test('defaults the language to null', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})

        expect((await createTranscriptRequest(db, 'item-a', 'whisper')).language).toBeNull()
        expect((await createTranscriptRequest(db, 'item-a', 'whisper', undefined)).language).toBeNull()
        expect(await countRows('transcript')).toBe(2)
    })
})

describe('listTranscriptsForItem', () => {
    test('lists the item\'s transcripts newest request first', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        await seedFeedItem('feed-a', {guid: 'item-b'})
        const first = await insertTranscript('item-a', {requested_at: dateAt(1)})
        const third = await insertTranscript('item-a', {requested_at: dateAt(3)})
        const second = await insertTranscript('item-a', {requested_at: dateAt(2)})
        await insertTranscript('item-b', {requested_at: dateAt(9)})

        const transcripts = await listTranscriptsForItem(db, 'item-a')
        expect(transcripts[0]).toBeInstanceOf(ServerTranscript)
        expect(transcripts.map(t => t.id)).toEqual([third, second, first])
    })

    test('returns an empty list for an item without transcripts', async () => {
        expect(await listTranscriptsForItem(db, 'nope')).toEqual([])
    })
})

describe('updateTranscriptStatus', () => {
    beforeEach(async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
    })

    test('does nothing for an empty patch', async () => {
        const id = await insertTranscript('item-a')
        const prepare = vi.spyOn(db, 'prepare')

        await updateTranscriptStatus(db, id, {})

        expect(prepare).not.toHaveBeenCalled()
        expect((await ServerTranscript.get(db, id))!.status).toBe('pending')
    })

    test('updates a single column', async () => {
        const id = await insertTranscript('item-a')

        await updateTranscriptStatus(db, id, {status: 'processing'})

        expect((await ServerTranscript.get(db, id))!.status).toBe('processing')
    })

    test('updates several columns at once', async () => {
        const id = await insertTranscript('item-a')

        await updateTranscriptStatus(db, id, {
            status: 'complete',
            text: 'spoken words',
            segments_json: '[{"start":0}]',
            language: 'en',
            batch_request_id: 'req-1',
            started_at: dateAt(1),
            completed_at: dateAt(2),
        })

        const transcript = (await ServerTranscript.get(db, id))!
        expect(transcript).toMatchObject({status: 'complete', text: 'spoken words', segments_json: '[{"start":0}]', language: 'en', batch_request_id: 'req-1'})
        expect(transcript.started_at).toEqual(new Date(dateAt(1)))
        expect(transcript.completed_at).toEqual(new Date(dateAt(2)))
    })

    test('writes undefined values as NULL', async () => {
        const id = await insertTranscript('item-a', {language: 'en'})
        await updateTranscriptStatus(db, id, {error_message: 'boom'})

        await updateTranscriptStatus(db, id, {language: undefined, error_message: undefined})

        const transcript = (await ServerTranscript.get(db, id))!
        expect(transcript.language).toBeNull()
        expect(transcript.error_message).toBeNull()
    })

    test('only touches the given transcript', async () => {
        const target = await insertTranscript('item-a')
        const other = await insertTranscript('item-a')

        await updateTranscriptStatus(db, target, {status: 'error', error_message: 'failed'})

        expect((await ServerTranscript.get(db, other))!).toMatchObject({status: 'pending', error_message: null})
    })
})

/******************************************************************************
 * Push subscriptions
 *****************************************************************************/

describe('countPushSubscriptions', () => {
    test('counts the stored subscriptions', async () => {
        expect(await countPushSubscriptions(db)).toBe(0)

        await upsertPushSubscription(db, 'https://push/1', 'p1', 'a1')
        await upsertPushSubscription(db, 'https://push/2', 'p2', 'a2')
        await upsertPushSubscription(db, 'https://push/2', 'p2b', 'a2b')

        expect(await countPushSubscriptions(db)).toBe(2)
    })
})

describe('getAllPushSubscriptions', () => {
    test('returns every subscription as an entity', async () => {
        expect(await getAllPushSubscriptions(db)).toEqual([])

        await upsertPushSubscription(db, 'https://push/1', 'p1', 'a1')
        await upsertPushSubscription(db, 'https://push/2', 'p2', 'a2')

        const subscriptions = await getAllPushSubscriptions(db)
        expect(subscriptions[0]).toBeInstanceOf(ServerPushSubscription)
        expect(subscriptions.map(s => [s.endpoint, s.p256dh, s.auth]).sort()).toEqual([
            ['https://push/1', 'p1', 'a1'],
            ['https://push/2', 'p2', 'a2'],
        ])
    })
})

describe('upsertPushSubscription', () => {
    test('inserts a new subscription stamped with the current time', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2024-06-07T08:09:10.000Z'))
        try {
            const subscription = await upsertPushSubscription(db, 'https://push/1', 'p1', 'a1')

            expect(subscription).toBeInstanceOf(ServerPushSubscription)
            expect(subscription).toMatchObject({endpoint: 'https://push/1', p256dh: 'p1', auth: 'a1', last_used_at: null})
            expect(subscription.created_at).toEqual(new Date('2024-06-07T08:09:10.000Z'))

            const rows = await db.prepare('SELECT * FROM push_subscription').all()
            expect(rows.results).toEqual([{endpoint: 'https://push/1', p256dh: 'p1', auth: 'a1', created_at: '2024-06-07T08:09:10.000Z', last_used_at: null}])
        } finally {
            vi.useRealTimers()
        }
    })

    test('re-subscribing the same endpoint updates the keys but keeps created_at', async () => {
        await upsertPushSubscription(db, 'https://push/1', 'p1', 'a1')
        const [original] = await getAllPushSubscriptions(db)

        await upsertPushSubscription(db, 'https://push/1', 'p2', 'a2')

        const subscriptions = await getAllPushSubscriptions(db)
        expect(subscriptions).toHaveLength(1)
        expect(subscriptions[0]).toMatchObject({endpoint: 'https://push/1', p256dh: 'p2', auth: 'a2'})
        expect(subscriptions[0].created_at).toEqual(original.created_at)
    })
})

describe('deletePushSubscription', () => {
    test('removes just the given endpoint', async () => {
        await upsertPushSubscription(db, 'https://push/1', 'p1', 'a1')
        await upsertPushSubscription(db, 'https://push/2', 'p2', 'a2')

        await deletePushSubscription(db, 'https://push/1')

        expect((await getAllPushSubscriptions(db)).map(s => s.endpoint)).toEqual(['https://push/2'])
    })

    test('is a no-op for an unknown endpoint', async () => {
        await upsertPushSubscription(db, 'https://push/1', 'p1', 'a1')

        await deletePushSubscription(db, 'https://push/nope')

        expect(await countPushSubscriptions(db)).toBe(1)
    })
})

describe('touchPushSubscription', () => {
    test('records when the subscription was last used', async () => {
        await upsertPushSubscription(db, 'https://push/1', 'p1', 'a1')
        await upsertPushSubscription(db, 'https://push/2', 'p2', 'a2')

        vi.useFakeTimers()
        vi.setSystemTime(new Date('2024-06-07T08:09:10.000Z'))
        try {
            await touchPushSubscription(db, 'https://push/1')
        } finally {
            vi.useRealTimers()
        }

        const lastUsed = Object.fromEntries((await getAllPushSubscriptions(db)).map(s => [s.endpoint, s.last_used_at]))
        expect(lastUsed).toEqual({'https://push/1': new Date('2024-06-07T08:09:10.000Z'), 'https://push/2': null})
    })

    test('is a no-op for an unknown endpoint', async () => {
        await upsertPushSubscription(db, 'https://push/1', 'p1', 'a1')

        await touchPushSubscription(db, 'https://push/nope')

        expect((await getAllPushSubscriptions(db))[0].last_used_at).toBeNull()
        expect(await countPushSubscriptions(db)).toBe(1)
    })
})
