import {createExecutionContext} from 'cloudflare:test'
import {env} from 'cloudflare:workers'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import worker from './service'
import {buildRss, countRows, mockFetch, resetStorage, seedFeed, seedFeedItem, seedFeedSource, testEnv} from './services/testing/fixtures'
import {type FeedProcessingTask} from './services/types'

const db = env.DB

const SOURCE_URL = 'https://example.com/podcast/feed.xml'
const CDX_URL_PREFIX = 'https://web.archive.org/cdx/search/cdx?'
const SNAPSHOT_URL = 'https://web.archive.org/web/20240101000000id_/https://example.com/podcast/feed.xml'

const RSS = buildRss({
    title: 'Example',
    guid: 'feed-a',
    selfLink: SOURCE_URL,
    items: [
        {guid: 'item-1', title: 'One', pubDate: 'Mon, 01 Jan 2024 00:00:00 GMT'},
        {guid: 'item-2', title: 'Two', pubDate: 'Tue, 02 Jan 2024 00:00:00 GMT'},
    ],
})

interface FakeMessage {
    id: string
    timestamp: Date
    attempts: number
    body: unknown
    ack: ReturnType<typeof vi.fn>
    retry: ReturnType<typeof vi.fn>
}

function message(body: unknown, id = 'msg-1'): FakeMessage {
    return {id, timestamp: new Date(), attempts: 1, body, ack: vi.fn(), retry: vi.fn()}
}

function batch(messages: FakeMessage[]) {
    return {queue: 'iris-feed-proc-prod', messages, ackAll: vi.fn(), retryAll: vi.fn()} as unknown as MessageBatch<FeedProcessingTask>
}

async function transcriptStatus(id: number) {
    const row = await db.prepare('SELECT status, error_message FROM transcript WHERE id = ?').bind(id)
        .first<{status: string, error_message: string | null}>()
    return row
}

beforeEach(async () => {
    await resetStorage()
    vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('fetch', () => {
    test('serves the API', async () => {
        const response = await worker.fetch(new Request('http://localhost/api/feed'), env, createExecutionContext())

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual([])
    })

    test('answers unknown routes with a JSON 404', async () => {
        const response = await worker.fetch(new Request('http://localhost/api/nothing'), env, createExecutionContext())

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({error: 'Not found'})
    })
})

describe('queue', () => {
    test('refresh-feed refreshes the feed from its sources', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        mockFetch({[SOURCE_URL]: new Response(RSS)})
        const {env: testenv} = testEnv()
        const msg = message({type: 'refresh-feed', feedGuid: 'feed-a'})

        await worker.queue(batch([msg]), testenv, createExecutionContext())

        expect(await countRows('feed_file')).toBe(1)
        const {results} = await db.prepare('SELECT guid FROM feed_item WHERE source_feed = ? ORDER BY guid').bind('feed-a').all<{guid: string}>()
        expect(results.map(r => r.guid)).toEqual(['item-1', 'item-2'])
        expect(msg.ack).toHaveBeenCalledTimes(1)
        expect(msg.retry).not.toHaveBeenCalled()
    })

    test('plan-feed-archives enqueues archive snapshot tasks', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        mockFetch(request => request.url.startsWith(CDX_URL_PREFIX)
            ? new Response(JSON.stringify([
                ['timestamp', 'original', 'digest'],
                ['20240101000000', SOURCE_URL, 'AAA'],
            ]))
            : undefined)
        const {env: testenv, queue} = testEnv()
        const msg = message({type: 'plan-feed-archives', feedGuid: 'feed-a'})

        await worker.queue(batch([msg]), testenv, createExecutionContext())

        expect(queue.messages.map(m => m.body)).toEqual([{
            type: 'fetch-archive-snapshot',
            feedSourceUrl: SOURCE_URL,
            feedGuid: 'feed-a',
            timestamp: 20240101000000,
            snapshotUrl: SNAPSHOT_URL,
        }])
        expect(msg.ack).toHaveBeenCalledTimes(1)
    })

    test('fetch-archive-snapshot stores the snapshot as an archive feed file', async () => {
        await seedFeed({guid: 'feed-a'})
        mockFetch({[SNAPSHOT_URL]: new Response(RSS)})
        const {env: testenv} = testEnv()
        const msg = message({
            type: 'fetch-archive-snapshot',
            feedSourceUrl: SOURCE_URL,
            feedGuid: 'feed-a',
            timestamp: 20240101000000,
            snapshotUrl: SNAPSHOT_URL,
        })

        await worker.queue(batch([msg]), testenv, createExecutionContext())

        const file = await db.prepare('SELECT feed_url, referenced_feed FROM feed_file').first<{feed_url: string, referenced_feed: string}>()
        expect(file).toEqual({feed_url: SNAPSHOT_URL, referenced_feed: 'feed-a'})
        const source = await db.prepare('SELECT archive FROM feed_source WHERE feed_url = ?').bind(SNAPSHOT_URL).first<{archive: number}>()
        expect(source?.archive).toBe(1)
        expect(await countRows('feed_item')).toBe(2)
        expect(msg.ack).toHaveBeenCalledTimes(1)
    })

    test('transcribe-feed-item advances the transcript', async () => {
        await seedFeed({guid: 'feed-a', type: 'podcast'})
        await seedFeedItem('feed-a', {guid: 'item-a', enclosure_url: null})
        await db.prepare(`INSERT INTO transcript (feed_item_guid, model, status, requested_at) VALUES (?, ?, 'pending', ?)`)
            .bind('item-a', 'whisper', new Date().toISOString()).run()
        const ai = {run: vi.fn()}
        const {env: testenv} = testEnv({AI: ai as unknown as Ai})
        const msg = message({type: 'transcribe-feed-item', transcriptId: 1})

        await worker.queue(batch([msg]), testenv, createExecutionContext())

        expect(await transcriptStatus(1)).toEqual({status: 'error', error_message: 'Feed item has no enclosure_url'})
        expect(ai.run).not.toHaveBeenCalled()
        expect(msg.ack).toHaveBeenCalledTimes(1)
    })

    test('acknowledges messages with an unknown task type', async () => {
        const {env: testenv, queue} = testEnv()
        const msg = message({type: 'unknown-task'})

        await worker.queue(batch([msg]), testenv, createExecutionContext())

        expect(msg.ack).toHaveBeenCalledTimes(1)
        expect(msg.retry).not.toHaveBeenCalled()
        expect(queue.messages).toEqual([])
    })

    test('processes every message of a batch in order', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b'})
        await seedFeedSource('feed-a', {feed_url: SOURCE_URL})
        mockFetch(request => {
            if (request.url === SOURCE_URL) return new Response(RSS)
            if (request.url.startsWith(CDX_URL_PREFIX)) return new Response(JSON.stringify([['timestamp', 'original', 'digest']]))
            return undefined
        })
        const {env: testenv} = testEnv()
        const order: string[] = []
        const messages = [
            message({type: 'plan-feed-archives', feedGuid: 'feed-b'}, 'first'),
            message({type: 'refresh-feed', feedGuid: 'feed-a'}, 'second'),
            message({type: 'unknown-task'}, 'third'),
        ]
        for (const msg of messages) msg.ack.mockImplementation(() => order.push(msg.id))

        await worker.queue(batch(messages), testenv, createExecutionContext())

        expect(order).toEqual(['first', 'second', 'third'])
        expect(messages.every(m => m.ack.mock.calls.length === 1)).toBe(true)
        expect(await countRows('feed_item')).toBe(2)
    })
})

describe('scheduled', () => {
    const controller = {scheduledTime: Date.now(), cron: '17 * * * *', noRetry: vi.fn()} as unknown as ScheduledController

    test('enqueues a refresh for every active feed', async () => {
        await seedFeed({guid: 'feed-a', active: true})
        await seedFeed({guid: 'feed-b', active: true})
        await seedFeed({guid: 'feed-c', active: false})
        const {env: testenv, queue} = testEnv()

        await worker.scheduled(controller, testenv, createExecutionContext())

        expect(queue.messages.map(m => m.body).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
            {type: 'refresh-feed', feedGuid: 'feed-a'},
            {type: 'refresh-feed', feedGuid: 'feed-b'},
        ])
    })

    test('sends nothing when there are no feeds', async () => {
        const {env: testenv, queue} = testEnv()

        await worker.scheduled(controller, testenv, createExecutionContext())

        expect(queue.send).not.toHaveBeenCalled()
    })
})
