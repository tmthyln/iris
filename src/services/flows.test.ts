import {describe, test, expect} from 'vitest'
import {classifyFeedItem, selectSnapshots, waybackTimestampToMs} from './flows'

describe('selectSnapshots', () => {
    test('returns empty for empty input', () => {
        expect(selectSnapshots([], 1000)).toEqual([])
    })

    test('returns single snapshot', () => {
        const snapshots = [{timestamp: 20230101120000, original: 'http://example.com/feed', digest: 'abc'}]
        expect(selectSnapshots(snapshots, 1000)).toEqual(snapshots)
    })

    test('always includes first and last', () => {
        const snapshots = [
            {timestamp: 20230101000000, original: 'http://example.com/feed', digest: 'a'},
            {timestamp: 20230102000000, original: 'http://example.com/feed', digest: 'b'},
            {timestamp: 20230103000000, original: 'http://example.com/feed', digest: 'c'},
        ]
        // with a very large interval, only first and last should be selected
        const result = selectSnapshots(snapshots, 365 * 24 * 60 * 60 * 1000)
        expect(result[0]).toEqual(snapshots[0])
        expect(result[result.length - 1]).toEqual(snapshots[2])
    })

    test('selects at interval spacing', () => {
        const snapshots = [
            {timestamp: 20230101000000, original: 'http://example.com/feed', digest: 'a'},
            {timestamp: 20230102000000, original: 'http://example.com/feed', digest: 'b'},
            {timestamp: 20230103000000, original: 'http://example.com/feed', digest: 'c'},
            {timestamp: 20230104000000, original: 'http://example.com/feed', digest: 'd'},
            {timestamp: 20230105000000, original: 'http://example.com/feed', digest: 'e'},
        ]
        // 2-day interval: should select indices 0, 2, 4
        const twoDays = 2 * 24 * 60 * 60 * 1000
        const result = selectSnapshots(snapshots, twoDays)
        expect(result).toEqual([snapshots[0], snapshots[2], snapshots[4]])
    })

    test('handles gaps by including both sides', () => {
        const snapshots = [
            {timestamp: 20230101000000, original: 'http://example.com/feed', digest: 'a'},
            {timestamp: 20230102000000, original: 'http://example.com/feed', digest: 'b'},
            // big gap here
            {timestamp: 20230201000000, original: 'http://example.com/feed', digest: 'c'},
            {timestamp: 20230202000000, original: 'http://example.com/feed', digest: 'd'},
        ]
        const sevenDays = 7 * 24 * 60 * 60 * 1000
        const result = selectSnapshots(snapshots, sevenDays)
        // Should include: first(0), gap-before(1), gap-after(2), last(3)
        expect(result).toEqual(snapshots)
    })
})

describe('waybackTimestampToMs', () => {
    test('parses full 14-digit timestamp', () => {
        // 2023-06-15T08:30:45Z
        expect(waybackTimestampToMs(20230615083045)).toBe(Date.UTC(2023, 5, 15, 8, 30, 45))
    })

    test('parses date-only timestamp (YYYYMMDD)', () => {
        // 2023-01-01T00:00:00Z
        expect(waybackTimestampToMs(20230101)).toBe(Date.UTC(2023, 0, 1, 0, 0, 0))
    })

    test('parses midnight timestamp with zeroed time', () => {
        expect(waybackTimestampToMs(20200301000000)).toBe(Date.UTC(2020, 2, 1, 0, 0, 0))
    })

    test('parses end-of-day timestamp', () => {
        expect(waybackTimestampToMs(20231231235959)).toBe(Date.UTC(2023, 11, 31, 23, 59, 59))
    })
})

describe('classifyFeedItem', () => {
    const HASH_A = 'aaaa'
    const HASH_B = 'bbbb'
    const T0 = new Date('2024-01-01T00:00:00Z')
    const T1 = new Date('2024-06-01T00:00:00Z')
    const T2 = new Date('2024-12-01T00:00:00Z')

    test("first item ever (no maxDate, no existing) is 'new'", () => {
        expect(classifyFeedItem({
            contentHash: HASH_A, itemDate: T1, existing: undefined, maxDate: null,
        })).toBe('new')
    })

    test("unseen item newer than cutoff is 'new'", () => {
        expect(classifyFeedItem({
            contentHash: HASH_A, itemDate: T2, existing: undefined, maxDate: T1,
        })).toBe('new')
    })

    test("unseen item older than cutoff is 'skip' (backfill)", () => {
        expect(classifyFeedItem({
            contentHash: HASH_A, itemDate: T0, existing: undefined, maxDate: T1,
        })).toBe('skip')
    })

    test("unseen item with no date is 'skip'", () => {
        expect(classifyFeedItem({
            contentHash: HASH_A, itemDate: null, existing: undefined, maxDate: null,
        })).toBe('skip')
    })

    test("known item with identical hash is 'skip'", () => {
        expect(classifyFeedItem({
            contentHash: HASH_A,
            itemDate: T1,
            existing: {date: T1, content_hash: HASH_A},
            maxDate: T1,
        })).toBe('skip')
    })

    test("known item with different hash is 'updated'", () => {
        expect(classifyFeedItem({
            contentHash: HASH_B,
            itemDate: T1,
            existing: {date: T1, content_hash: HASH_A},
            maxDate: T1,
        })).toBe('updated')
    })

    test("legacy item (existing hash is null) is 'skip' even if hashes differ", () => {
        expect(classifyFeedItem({
            contentHash: HASH_A,
            itemDate: T1,
            existing: {date: T1, content_hash: null},
            maxDate: T1,
        })).toBe('skip')
    })

    test("unseen item with itemDate exactly at maxDate is 'skip'", () => {
        // strict > so equal counts as already-known
        expect(classifyFeedItem({
            contentHash: HASH_A, itemDate: T1, existing: undefined, maxDate: T1,
        })).toBe('skip')
    })
})

/******************************************************************************
 * Flows against the real bindings
 *****************************************************************************/

import {env} from 'cloudflare:workers'
import type {ExecutionContext} from '@cloudflare/workers-types'
import {afterEach, beforeEach, vi} from 'vitest'
import {fetchArchiveSnapshot, planFeedArchives, refreshFeed, transcribeFeedItem} from './flows'
import {createTranscriptRequest} from './crud'
import {ServerFeedItem} from './models'
import {sha256Encode} from './utils/files'
import {
    buildRss,
    countRows,
    dateAt,
    mockFetch,
    resetStorage,
    seedFeed,
    seedFeedItem,
    seedFeedSource,
    stubWebPush,
    testEnv,
    type RssItemSpec,
} from './testing/fixtures'

const db = env.DB

beforeEach(() => resetStorage())
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const SOURCE_URL = 'https://example.com/feed.xml'
const SOURCE_URL_2 = 'https://mirror.example.com/feed.xml'

function rssResponse(items: RssItemSpec[], title = 'Feed A') {
    return new Response(buildRss({title, guid: 'feed-a', items}), {
        headers: {'content-type': 'application/rss+xml', date: 'Mon, 01 Jan 2024 00:00:00 GMT'},
    })
}

/** RFC 2822 date `n` days after 2024-01-01, as used in <pubDate>. */
function pubDate(n: number) {
    return new Date(dateAt(n)).toUTCString()
}

async function notifications() {
    const {results} = await db
        .prepare('SELECT type, feed_guid, feed_item_guid FROM notification ORDER BY id')
        .all<{type: string, feed_guid: string, feed_item_guid: string}>()
    return results
}

async function seedSubscription(endpoint = 'https://push.example.com/sub-1') {
    await db.prepare('INSERT INTO push_subscription (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)')
        .bind(endpoint, 'p256dh', 'auth', dateAt(0)).run()
}

describe('refreshFeed', () => {
    test('does nothing for an unknown feed', async () => {
        const {fetchMock} = mockFetch({})
        const {env: testEnvironment} = testEnv()

        await refreshFeed('nope', testEnvironment)

        expect(fetchMock).not.toHaveBeenCalled()
        expect(await countRows('feed_file')).toBe(0)
    })

    test('skips a source whose fetch fails', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        mockFetch({[SOURCE_URL]: new Response('nope', {status: 500})})
        const {env: testEnvironment} = testEnv()

        await refreshFeed('feed-a', testEnvironment)

        expect(await countRows('feed_file')).toBe(0)
        expect(await countRows('feed_item')).toBe(0)
    })

    test('persists the fetched file, caches it in R2 and stores the items with content hashes', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        const rss = rssResponse([
            {guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(1), description: 'first'},
            {guid: 'ep-2', title: 'Episode 2', pubDate: pubDate(2), description: 'second'},
        ])
        const body = await rss.clone().text()
        mockFetch({[SOURCE_URL]: rss})
        const {env: testEnvironment} = testEnv()

        await refreshFeed('feed-a', testEnvironment)

        const file = await db.prepare('SELECT * FROM feed_file').first<{feed_url: string, referenced_feed: string, cached_file: string, sha256_hash: string, fetched_at: string}>()
        expect(file).toMatchObject({feed_url: SOURCE_URL, referenced_feed: 'feed-a', sha256_hash: await sha256Encode(body)})
        expect(file!.fetched_at).toBe('2024-01-01T00:00:00.000Z')
        expect(file!.cached_file).toBe(`cached-file-${await sha256Encode(SOURCE_URL)}-${Date.UTC(2024, 0, 1)}.rss`)
        expect(await (await env.RSS_CACHE_BUCKET.get(file!.cached_file))!.text()).toBe(body)

        const items = await db.prepare('SELECT guid, title, source_feed, content_hash, date FROM feed_item ORDER BY guid')
            .all<{guid: string, title: string, source_feed: string, content_hash: string | null, date: string}>()
        expect(items.results).toEqual([
            {guid: 'ep-1', title: 'Episode 1', source_feed: 'feed-a', content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string, date: dateAt(1)},
            {guid: 'ep-2', title: 'Episode 2', source_feed: 'feed-a', content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string, date: dateAt(2)},
        ])
        expect(await notifications()).toEqual([])
    })

    test('a refresh with identical content is a no-op', async () => {
        await seedFeed({guid: 'feed-a', notify_enabled: true})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        mockFetch({[SOURCE_URL]: rssResponse([{guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(1)}])})
        const {env: testEnvironment} = testEnv()

        await refreshFeed('feed-a', testEnvironment)
        await refreshFeed('feed-a', testEnvironment)

        expect(await countRows('feed_file')).toBe(1)
        expect(await countRows('feed_item')).toBe(1)
        expect(await notifications()).toHaveLength(1)
    })

    test('with notifications enabled, classifies new, updated, unchanged, backfilled and undated items', async () => {
        await seedFeed({guid: 'feed-a', notify_enabled: true})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        const {env: testEnvironment} = testEnv()

        mockFetch({[SOURCE_URL]: rssResponse([
            {guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(5)},
            {guid: 'ep-2', title: 'Episode 2', pubDate: pubDate(6)},
        ])})
        await refreshFeed('feed-a', testEnvironment)
        expect(await notifications()).toEqual([
            {type: 'new_item', feed_guid: 'feed-a', feed_item_guid: 'ep-1'},
            {type: 'new_item', feed_guid: 'feed-a', feed_item_guid: 'ep-2'},
        ])

        vi.unstubAllGlobals()
        mockFetch({[SOURCE_URL]: rssResponse([
            {guid: 'ep-1', title: 'Episode 1 (remastered)', pubDate: pubDate(5)},   // changed content
            {guid: 'ep-2', title: 'Episode 2', pubDate: pubDate(6)},                // unchanged
            {guid: 'ep-0', title: 'Episode 0', pubDate: pubDate(1)},                // older than the cutoff
            {guid: 'ep-x', title: 'Undated'},                                       // no pubDate
            {guid: 'ep-3', title: 'Episode 3', pubDate: pubDate(7)},                // new
        ])})
        await refreshFeed('feed-a', testEnvironment)

        expect((await notifications()).slice(2)).toEqual([
            {type: 'updated_item', feed_guid: 'feed-a', feed_item_guid: 'ep-1'},
            {type: 'new_item', feed_guid: 'feed-a', feed_item_guid: 'ep-3'},
        ])
        // everything is persisted regardless of the classification
        const items = await db.prepare('SELECT guid, title, date FROM feed_item ORDER BY guid').all<{guid: string, title: string, date: string | null}>()
        expect(items.results).toEqual([
            {guid: 'ep-0', title: 'Episode 0', date: dateAt(1)},
            {guid: 'ep-1', title: 'Episode 1 (remastered)', date: dateAt(5)},
            {guid: 'ep-2', title: 'Episode 2', date: dateAt(6)},
            {guid: 'ep-3', title: 'Episode 3', date: dateAt(7)},
            {guid: 'ep-x', title: 'Undated', date: null},
        ])
    })

    test('does not re-notify an item served by a second source in the same refresh', async () => {
        await seedFeed({guid: 'feed-a', notify_enabled: true})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL_2})
        const {env: testEnvironment} = testEnv()
        mockFetch({
            [SOURCE_URL]: rssResponse([{guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(1)}]),
            // different document (title), same item
            [SOURCE_URL_2]: rssResponse([{guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(1)}], 'Feed A mirror'),
        })

        await refreshFeed('feed-a', testEnvironment)

        expect(await countRows('feed_file')).toBe(2)
        expect(await notifications()).toEqual([{type: 'new_item', feed_guid: 'feed-a', feed_item_guid: 'ep-1'}])
    })

    test('skips sources that are archives or not actively updating', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL, archive: true})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL_2, actively_updating: false})
        const {fetchMock} = mockFetch({})
        const {env: testEnvironment} = testEnv()

        await refreshFeed('feed-a', testEnvironment)

        expect(fetchMock).not.toHaveBeenCalled()
    })

    describe('push fan-out', () => {
        test('sends one push per notifiable item, awaited inline without a context', async () => {
            await seedFeed({guid: 'feed-a', title: 'Feed Title', alias: '', notify_enabled: true})
            await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
            await seedSubscription()
            const send = stubWebPush()
            mockFetch({[SOURCE_URL]: rssResponse([
                {guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(1)},
                {guid: 'https://example.com/ep 2', title: 'Episode 2', pubDate: pubDate(2)},
            ])})
            const {env: testEnvironment} = testEnv()

            await refreshFeed('feed-a', testEnvironment)

            expect(send).toHaveBeenCalledTimes(2)
            expect(send.mock.calls[0][0]).toEqual({endpoint: 'https://push.example.com/sub-1', keys: {p256dh: 'p256dh', auth: 'auth'}})
            expect(JSON.parse(send.mock.calls[0][1] as string)).toEqual({
                type: 'new_item',
                feed_guid: 'feed-a',
                feed_item_guid: 'ep-1',
                title: 'Feed Title',
                body: 'Episode 1',
                url: '/feeditem/ep-1',
            })
            expect(JSON.parse(send.mock.calls[1][1] as string)).toMatchObject({
                feed_item_guid: 'https://example.com/ep 2',
                url: '/feeditem/https%3A%2F%2Fexample.com%2Fep%202',
            })
            expect(send.mock.calls[0][2]).toMatchObject({
                TTL: 86400,
                vapidDetails: {subject: 'mailto:test@example.com', publicKey: 'test-vapid-public-key', privateKey: 'test-vapid-private-key'},
            })
            const touched = await db.prepare('SELECT last_used_at FROM push_subscription').first<{last_used_at: string | null}>()
            expect(touched!.last_used_at).not.toBeNull()
        })

        test('uses the alias as the title and an "Updated:" body for updated items', async () => {
            await seedFeed({guid: 'feed-a', title: 'Feed Title', alias: 'My Alias', notify_enabled: true})
            await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
            await seedFeedItem('feed-a', {guid: 'ep-1', title: 'Old', date: dateAt(1), content_hash: 'stale'})
            await seedSubscription()
            const send = stubWebPush()
            mockFetch({[SOURCE_URL]: rssResponse([{guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(1)}])})
            const {env: testEnvironment} = testEnv()

            await refreshFeed('feed-a', testEnvironment)

            expect(await notifications()).toEqual([{type: 'updated_item', feed_guid: 'feed-a', feed_item_guid: 'ep-1'}])
            expect(send).toHaveBeenCalledTimes(1)
            expect(JSON.parse(send.mock.calls[0][1] as string)).toMatchObject({type: 'updated_item', title: 'My Alias', body: 'Updated: Episode 1'})
        })

        test('defers the sends to ctx.waitUntil when a context is given', async () => {
            await seedFeed({guid: 'feed-a', notify_enabled: true})
            await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
            await seedSubscription()
            const send = stubWebPush()
            mockFetch({[SOURCE_URL]: rssResponse([{guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(1)}])})
            const {env: testEnvironment} = testEnv()
            const pending: Promise<unknown>[] = []
            const waitUntil = vi.fn((promise: Promise<unknown>) => { pending.push(promise) })
            const ctx = {waitUntil, passThroughOnException: vi.fn()} as unknown as ExecutionContext

            await refreshFeed('feed-a', testEnvironment, ctx)

            expect(waitUntil).toHaveBeenCalledTimes(1)
            await Promise.all(pending)
            expect(send).toHaveBeenCalledTimes(1)
        })

        test('still records notifications when there are no subscribers', async () => {
            await seedFeed({guid: 'feed-a', notify_enabled: true})
            await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
            const send = stubWebPush()
            mockFetch({[SOURCE_URL]: rssResponse([{guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(1)}])})
            const {env: testEnvironment} = testEnv()

            await refreshFeed('feed-a', testEnvironment)

            expect(await notifications()).toHaveLength(1)
            expect(send).not.toHaveBeenCalled()
        })

        test('does not send anything when notifications are disabled', async () => {
            await seedFeed({guid: 'feed-a', notify_enabled: false})
            await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
            await seedSubscription()
            const send = stubWebPush()
            mockFetch({[SOURCE_URL]: rssResponse([{guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(1)}])})
            const {env: testEnvironment} = testEnv()

            await refreshFeed('feed-a', testEnvironment)

            expect(await notifications()).toEqual([])
            expect(send).not.toHaveBeenCalled()
        })
    })
})

describe('planFeedArchives', () => {
    const CDX_PREFIX = 'https://web.archive.org/cdx/search/cdx?'

    /** CDX rows for daily snapshots of SOURCE_URL starting 2024-01-01. */
    function cdxRows(days: number) {
        return Array.from({length: days}, (_, i) => [`2024010${i + 1}000000`, SOURCE_URL, `digest-${i + 1}`])
    }

    function mockCdx(rows: string[][]) {
        return mockFetch(request => request.url.startsWith(CDX_PREFIX)
            ? new Response(JSON.stringify([['timestamp', 'original', 'digest'], ...rows]))
            : undefined)
    }

    async function seedFeedFiles(fetchedAt: string[]) {
        for (const [i, at] of fetchedAt.entries()) {
            await db.prepare('INSERT INTO feed_file (feed_url, fetched_at, referenced_feed, cached_file, sha256_hash) VALUES (?, ?, ?, ?, ?)')
                .bind(SOURCE_URL, at, 'feed-a', `file-${i}`, `hash-${i}`).run()
        }
    }

    function enqueuedTimestamps(messages: {body: {type: string, timestamp?: number}}[]) {
        return messages.map(m => m.body.type === 'fetch-archive-snapshot' ? m.body.timestamp : undefined)
    }

    test('does nothing for an unknown feed', async () => {
        const {fetchMock} = mockFetch({})
        const {env: testEnvironment, queue} = testEnv()

        await planFeedArchives('nope', testEnvironment)

        expect(fetchMock).not.toHaveBeenCalled()
        expect(queue.messages).toEqual([])
    })

    test('returns early when archives were already planned or there are no live sources', async () => {
        const {fetchMock} = mockFetch({})
        const {env: testEnvironment, queue} = testEnv()

        await seedFeed({guid: 'feed-a'})
        await planFeedArchives('feed-a', testEnvironment)  // no sources at all

        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        await seedFeedSource('feed-a', {feed_url: 'https://web.archive.org/web/1id_/x', archive: true})
        await planFeedArchives('feed-a', testEnvironment)  // archive source exists

        expect(fetchMock).not.toHaveBeenCalled()
        expect(queue.messages).toEqual([])
    })

    test('enqueues a fetch task per selected snapshot (30-day default interval keeps first and last)', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        const {calls} = mockCdx(cdxRows(5))
        const {env: testEnvironment, queue} = testEnv()

        await planFeedArchives('feed-a', testEnvironment)

        expect(calls).toHaveLength(1)
        expect(calls[0].url).toContain(`url=${encodeURIComponent(SOURCE_URL)}`)
        expect(queue.messages).toEqual([
            {body: {type: 'fetch-archive-snapshot', feedSourceUrl: SOURCE_URL, feedGuid: 'feed-a', timestamp: 20240101000000, snapshotUrl: `https://web.archive.org/web/20240101000000id_/${SOURCE_URL}`}, options: undefined},
            {body: {type: 'fetch-archive-snapshot', feedSourceUrl: SOURCE_URL, feedGuid: 'feed-a', timestamp: 20240105000000, snapshotUrl: `https://web.archive.org/web/20240105000000id_/${SOURCE_URL}`}, options: undefined},
        ])
    })

    test('derives the interval from the gaps between feed files', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        // 4 days apart → 2-day interval → snapshots 1, 3, 5
        await seedFeedFiles([dateAt(0), dateAt(4)])
        mockCdx(cdxRows(5))
        const {env: testEnvironment, queue} = testEnv()

        await planFeedArchives('feed-a', testEnvironment)

        expect(enqueuedTimestamps(queue.messages)).toEqual([20240101000000, 20240103000000, 20240105000000])
    })

    test('clamps the interval to at least one day', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        // an hour apart → 30 minutes → clamped to 1 day → every daily snapshot
        await seedFeedFiles(['2024-01-01T00:00:00.000Z', '2024-01-01T01:00:00.000Z', '2024-01-01T02:00:00.000Z'])
        mockCdx(cdxRows(5))
        const {env: testEnvironment, queue} = testEnv()

        await planFeedArchives('feed-a', testEnvironment)

        expect(enqueuedTimestamps(queue.messages)).toEqual([20240101000000, 20240102000000, 20240103000000, 20240104000000, 20240105000000])
    })

    test('clamps the interval to at most thirty days', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        // 120 days apart → 60 days → clamped to 30 → first and last only
        await seedFeedFiles([dateAt(0), dateAt(120)])
        mockCdx(cdxRows(5))
        const {env: testEnvironment, queue} = testEnv()

        await planFeedArchives('feed-a', testEnvironment)

        expect(enqueuedTimestamps(queue.messages)).toEqual([20240101000000, 20240105000000])
    })

    test('falls back to half the item date range when there is at most one feed file', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        await seedFeedFiles([dateAt(0)])
        // items span 4 days → 2-day interval
        await seedFeedItem('feed-a', {date: dateAt(10)})
        await seedFeedItem('feed-a', {date: dateAt(14)})
        mockCdx(cdxRows(5))
        const {env: testEnvironment, queue} = testEnv()

        await planFeedArchives('feed-a', testEnvironment)

        expect(enqueuedTimestamps(queue.messages)).toEqual([20240101000000, 20240103000000, 20240105000000])
    })

    test('enqueues nothing when the archive has no snapshots', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        mockCdx([])
        const {env: testEnvironment, queue} = testEnv()

        await planFeedArchives('feed-a', testEnvironment)

        expect(queue.messages).toEqual([])
    })

    test('plans every live source, skipping archive sources', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL_2})
        const {calls} = mockFetch(request => request.url.startsWith(CDX_PREFIX)
            ? new Response(JSON.stringify([['timestamp', 'original', 'digest'], ['20240101000000', 'https://any', 'd']]))
            : undefined)
        const {env: testEnvironment, queue} = testEnv()

        await planFeedArchives('feed-a', testEnvironment)

        expect(calls.map(c => new URL(c.url).searchParams.get('url')).sort()).toEqual([SOURCE_URL, SOURCE_URL_2].sort())
        expect(queue.messages.map(m => m.body.type === 'fetch-archive-snapshot' ? m.body.feedSourceUrl : undefined).sort())
            .toEqual([SOURCE_URL, SOURCE_URL_2].sort())
    })
})

describe('fetchArchiveSnapshot', () => {
    const SNAPSHOT_URL = `https://web.archive.org/web/20240101000000id_/${SOURCE_URL}`
    const task = {
        type: 'fetch-archive-snapshot' as const,
        feedSourceUrl: SOURCE_URL,
        feedGuid: 'feed-a',
        timestamp: 20240101000000,
        snapshotUrl: SNAPSHOT_URL,
    }

    function snapshotRss(items: RssItemSpec[]) {
        return buildRss({title: 'Feed A (archived)', guid: 'feed-a', items})
    }

    test('does nothing for an unknown feed', async () => {
        const {fetchMock} = mockFetch({})
        const {env: testEnvironment} = testEnv()

        await fetchArchiveSnapshot(task, testEnvironment)

        expect(fetchMock).not.toHaveBeenCalled()
    })

    test('gives up when the snapshot cannot be fetched, is not ok, or is not RSS', async () => {
        await seedFeed({guid: 'feed-a'})
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const {env: testEnvironment} = testEnv()

        mockFetch({})  // unknown URL → fetch rejects
        await fetchArchiveSnapshot(task, testEnvironment)
        expect(log).toHaveBeenLastCalledWith(`Failed to fetch archive snapshot: ${SNAPSHOT_URL}`)

        vi.unstubAllGlobals()
        mockFetch({[SNAPSHOT_URL]: new Response('gone', {status: 404})})
        await fetchArchiveSnapshot(task, testEnvironment)
        expect(log).toHaveBeenLastCalledWith(`Archive snapshot returned 404: ${SNAPSHOT_URL}`)

        vi.unstubAllGlobals()
        mockFetch({[SNAPSHOT_URL]: new Response('hello')})
        await fetchArchiveSnapshot(task, testEnvironment)
        expect(log).toHaveBeenLastCalledWith(`Archive snapshot is not valid RSS: ${SNAPSHOT_URL}`)

        expect(await countRows('feed_source')).toBe(0)
        expect(await countRows('feed_file')).toBe(0)
        expect(await countRows('feed_item')).toBe(0)
    })

    test('creates the archive source, caches the file and persists the items', async () => {
        await seedFeed({guid: 'feed-a'})
        const content = snapshotRss([
            {guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(1)},
            {guid: 'ep-2', title: 'Episode 2', pubDate: pubDate(2)},
        ])
        mockFetch({[SNAPSHOT_URL]: new Response(content)})
        const {env: testEnvironment} = testEnv()

        await fetchArchiveSnapshot(task, testEnvironment)

        const source = await db.prepare('SELECT * FROM feed_source').first<{feed_url: string, referenced_feed: string, archive: number, actively_updating: number, primary_source: number}>()
        expect(source).toMatchObject({feed_url: SNAPSHOT_URL, referenced_feed: 'feed-a', archive: 1, actively_updating: 0, primary_source: 0})

        const file = await db.prepare('SELECT * FROM feed_file').first<{feed_url: string, referenced_feed: string, cached_file: string, sha256_hash: string}>()
        expect(file).toEqual(expect.objectContaining({
            feed_url: SNAPSHOT_URL,
            referenced_feed: 'feed-a',
            cached_file: `cached-file-${await sha256Encode(SNAPSHOT_URL)}-20240101000000.rss`,
            sha256_hash: await sha256Encode(content),
        }))
        expect(await (await env.RSS_CACHE_BUCKET.get(file!.cached_file))!.text()).toBe(content)

        const items = await db.prepare('SELECT guid, source_feed, content_hash FROM feed_item ORDER BY guid').all<{guid: string, source_feed: string, content_hash: string | null}>()
        expect(items.results).toEqual([
            {guid: 'ep-1', source_feed: 'feed-a', content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string},
            {guid: 'ep-2', source_feed: 'feed-a', content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string},
        ])
    })

    test('never overwrites items that already exist', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'ep-1', title: 'Current title', finished: true})
        mockFetch({[SNAPSHOT_URL]: new Response(snapshotRss([
            {guid: 'ep-1', title: 'Archived title', pubDate: pubDate(1)},
            {guid: 'ep-old', title: 'Archived only', pubDate: pubDate(0)},
        ]))})
        const {env: testEnvironment} = testEnv()

        await fetchArchiveSnapshot(task, testEnvironment)

        const items = await db.prepare('SELECT guid, title, finished FROM feed_item ORDER BY guid').all<{guid: string, title: string, finished: number}>()
        expect(items.results).toEqual([
            {guid: 'ep-1', title: 'Current title', finished: 1},
            {guid: 'ep-old', title: 'Archived only', finished: 0},
        ])
    })

    test('skips content that has already been cached and reuses the archive source', async () => {
        await seedFeed({guid: 'feed-a'})
        const {env: testEnvironment} = testEnv()

        mockFetch({[SNAPSHOT_URL]: new Response(snapshotRss([{guid: 'ep-1', title: 'Episode 1', pubDate: pubDate(1)}]))})
        await fetchArchiveSnapshot(task, testEnvironment)
        await fetchArchiveSnapshot(task, testEnvironment)  // identical content
        expect(await countRows('feed_file')).toBe(1)

        vi.unstubAllGlobals()
        mockFetch({[SNAPSHOT_URL]: new Response(snapshotRss([{guid: 'ep-2', title: 'Episode 2', pubDate: pubDate(2)}]))})
        await fetchArchiveSnapshot(task, testEnvironment)  // new content, same snapshot URL

        expect(await countRows('feed_source')).toBe(1)
        expect(await countRows('feed_file')).toBe(2)
        expect(await countRows('feed_item')).toBe(2)
    })
})

describe('transcribeFeedItem', () => {
    const MODEL = '@cf/openai/whisper-large-v3-turbo'
    const AUDIO_URL = 'https://cdn.example.com/episode.mp3'
    const ONE_HOUR_MS = 60 * 60 * 1000

    function fakeAi() {
        return {run: vi.fn()}
    }

    function transcribeEnv(ai = fakeAi()) {
        const {env: testEnvironment, queue} = testEnv({AI: ai as unknown as Ai})
        return {env: testEnvironment, queue, ai}
    }

    async function seedItemWithAudio(guid = 'ep-1') {
        await seedFeed({guid: 'feed-a', type: 'podcast'})
        return seedFeedItem('feed-a', {guid, enclosure_url: AUDIO_URL, encoded_content: '<p>Show notes</p>'})
    }

    async function transcriptRow(id: number) {
        return (await db.prepare('SELECT * FROM transcript WHERE id = ?').bind(id)
            .first<{status: string, error_message: string | null, batch_request_id: string | null, started_at: string | null, completed_at: string | null, text: string | null, segments_json: string | null, language: string | null}>())!
    }

    async function setProcessing(id: number, startedAt: string, batchRequestId: string | null = 'req-1') {
        await db.prepare('UPDATE transcript SET status = ?, started_at = ?, batch_request_id = ? WHERE id = ?')
            .bind('processing', startedAt, batchRequestId, id).run()
    }

    test('ignores unknown ids and finished transcripts', async () => {
        await seedItemWithAudio()
        const {env: testEnvironment, ai, queue} = transcribeEnv()
        const {fetchMock} = mockFetch({})

        await transcribeFeedItem(999, testEnvironment)

        for (const status of ['complete', 'error']) {
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            await db.prepare('UPDATE transcript SET status = ? WHERE id = ?').bind(status, transcript.id).run()
            await transcribeFeedItem(transcript.id, testEnvironment)
            expect((await transcriptRow(transcript.id)).status).toBe(status)
        }

        expect(fetchMock).not.toHaveBeenCalled()
        expect(ai.run).not.toHaveBeenCalled()
        expect(queue.messages).toEqual([])
    })

    test('fails when the item has no enclosure', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'ep-1', enclosure_url: null})
        const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
        const {env: testEnvironment, ai} = transcribeEnv()

        await transcribeFeedItem(transcript.id, testEnvironment)

        expect(await transcriptRow(transcript.id)).toMatchObject({
            status: 'error',
            error_message: 'Feed item has no enclosure_url',
            completed_at: expect.any(String) as string,
        })
        expect(ai.run).not.toHaveBeenCalled()
    })

    describe('pending', () => {
        test('records an error when the audio cannot be downloaded', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            mockFetch({[AUDIO_URL]: new Response('', {status: 500})})
            const {env: testEnvironment, ai, queue} = transcribeEnv()

            await transcribeFeedItem(transcript.id, testEnvironment)

            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'error', error_message: 'Upstream fetch failed: HTTP 500'})
            expect(ai.run).not.toHaveBeenCalled()
            expect(queue.messages).toEqual([])
        })

        test('records an error when the batch submission returns no request id', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            mockFetch({[AUDIO_URL]: new Response('audio-bytes')})
            const ai = fakeAi()
            ai.run.mockResolvedValue({status: 'rejected'})
            const {env: testEnvironment, queue} = transcribeEnv(ai)

            await transcribeFeedItem(transcript.id, testEnvironment)

            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'error', error_message: 'Batch submission returned no request_id'})
            expect(queue.messages).toEqual([])
        })

        test('records non-Error rejections as strings', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            mockFetch({[AUDIO_URL]: new Response('audio-bytes')})
            const ai = fakeAi()
            ai.run.mockRejectedValue('quota exceeded')
            const {env: testEnvironment} = transcribeEnv(ai)

            await transcribeFeedItem(transcript.id, testEnvironment)

            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'error', error_message: 'quota exceeded'})
        })

        test('submits the audio as a batch request and re-enqueues a poll', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            const {calls} = mockFetch({[AUDIO_URL]: new Response('audio-bytes')})
            const ai = fakeAi()
            ai.run.mockResolvedValue({request_id: 'req-42', status: 'queued'})
            const {env: testEnvironment, queue} = transcribeEnv(ai)

            await transcribeFeedItem(transcript.id, testEnvironment)

            expect(calls[0].headers.get('user-agent')).toContain('Iris')
            expect(ai.run).toHaveBeenCalledWith(
                MODEL,
                {audio: btoa('audio-bytes'), task: 'transcribe', vad_filter: true},
                {queueRequest: true},
            )
            expect(await transcriptRow(transcript.id)).toMatchObject({
                status: 'processing',
                batch_request_id: 'req-42',
                started_at: expect.any(String) as string,
                completed_at: null,
            })
            expect(queue.messages).toEqual([
                {body: {type: 'transcribe-feed-item', transcriptId: transcript.id}, options: {delaySeconds: 30}},
            ])
        })

        test('passes the requested language through', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL, 'de')
            mockFetch({[AUDIO_URL]: new Response('audio-bytes')})
            const ai = fakeAi()
            ai.run.mockResolvedValue({request_id: 'req-42'})
            const {env: testEnvironment} = transcribeEnv(ai)

            await transcribeFeedItem(transcript.id, testEnvironment)

            expect(ai.run.mock.calls[0][1]).toMatchObject({language: 'de'})
        })
    })

    describe('processing', () => {
        test('fails when the batch request id is missing', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            await setProcessing(transcript.id, new Date().toISOString(), null)
            const {env: testEnvironment, ai} = transcribeEnv()

            await transcribeFeedItem(transcript.id, testEnvironment)

            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'error', error_message: 'Processing transcript has no batch_request_id'})
            expect(ai.run).not.toHaveBeenCalled()
        })

        test('times out after an hour', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            await setProcessing(transcript.id, new Date(Date.now() - ONE_HOUR_MS - 1000).toISOString())
            const {env: testEnvironment, ai, queue} = transcribeEnv()

            await transcribeFeedItem(transcript.id, testEnvironment)

            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'error', error_message: 'Timed out waiting for Whisper batch result'})
            expect(ai.run).not.toHaveBeenCalled()
            expect(queue.messages).toEqual([])
        })

        test('stores a completed transcript and re-indexes the item for search', async () => {
            const item = await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            await setProcessing(transcript.id, new Date().toISOString())
            const ai = fakeAi()
            ai.run.mockResolvedValue({
                status: 'complete',
                responses: [{success: true, result: {text: 'spoken words', transcription_info: {language: 'fr'}, segments: [{start: 0, end: 1, text: 'spoken words'}]}}],
            })
            const {env: testEnvironment, queue} = transcribeEnv(ai)

            await transcribeFeedItem(transcript.id, testEnvironment)

            expect(ai.run).toHaveBeenCalledWith(MODEL, {request_id: 'req-1'})
            expect(await transcriptRow(transcript.id)).toMatchObject({
                status: 'complete',
                text: 'spoken words',
                segments_json: JSON.stringify([{start: 0, end: 1, text: 'spoken words'}]),
                language: 'fr',
                completed_at: expect.any(String) as string,
            })
            const indexed = await db.prepare('SELECT content FROM text_search WHERE guid = ?').bind(item.guid).first<{content: string}>()
            expect(indexed!.content).toBe('Show notes\n\nspoken words')
            expect(queue.messages).toEqual([])
            expect((await ServerFeedItem.get(db, 'ep-1'))!.guid).toBe('ep-1')
        })

        test('accepts an inline result and keeps the requested language when none is detected', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL, 'en')
            await setProcessing(transcript.id, new Date().toISOString())
            const ai = fakeAi()
            ai.run.mockResolvedValue({success: true, result: {text: 'inline words'}})
            const {env: testEnvironment} = transcribeEnv(ai)

            await transcribeFeedItem(transcript.id, testEnvironment)

            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'complete', text: 'inline words', segments_json: null, language: 'en'})
        })

        test('records inference failures', async () => {
            await seedItemWithAudio()
            const {env: testEnvironment, ai, queue} = transcribeEnv()

            const failed = await createTranscriptRequest(db, 'ep-1', MODEL)
            await setProcessing(failed.id, new Date().toISOString())
            ai.run.mockResolvedValueOnce({responses: [{success: false, error: {code: 'E1', message: 'bad audio'}}]})
            await transcribeFeedItem(failed.id, testEnvironment)
            expect(await transcriptRow(failed.id)).toMatchObject({status: 'error', error_message: JSON.stringify({code: 'E1', message: 'bad audio'})})

            const failedSilently = await createTranscriptRequest(db, 'ep-1', MODEL)
            await setProcessing(failedSilently.id, new Date().toISOString())
            ai.run.mockResolvedValueOnce({success: false})
            await transcribeFeedItem(failedSilently.id, testEnvironment)
            expect(await transcriptRow(failedSilently.id)).toMatchObject({status: 'error', error_message: 'Inference failed'})

            expect(queue.messages).toEqual([])
        })

        test('polls again while the batch is still running', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            await setProcessing(transcript.id, new Date().toISOString())
            const ai = fakeAi()
            ai.run.mockResolvedValue({status: 'running'})
            const {env: testEnvironment, queue} = transcribeEnv(ai)

            await transcribeFeedItem(transcript.id, testEnvironment)

            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'processing', completed_at: null})
            expect(queue.messages).toEqual([
                {body: {type: 'transcribe-feed-item', transcriptId: transcript.id}, options: {delaySeconds: 30}},
            ])
        })

        test('treats a failed poll as transient and polls again', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            await setProcessing(transcript.id, new Date().toISOString())
            const error = vi.spyOn(console, 'error').mockImplementation(() => {})
            const ai = fakeAi()
            ai.run.mockRejectedValue(new Error('network'))
            const {env: testEnvironment, queue} = transcribeEnv(ai)

            await transcribeFeedItem(transcript.id, testEnvironment)

            expect(error).toHaveBeenCalledWith('[transcribe] poll error', expect.any(Error))
            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'processing'})
            expect(queue.messages).toEqual([
                {body: {type: 'transcribe-feed-item', transcriptId: transcript.id}, options: {delaySeconds: 30}},
            ])
        })
    })
})
