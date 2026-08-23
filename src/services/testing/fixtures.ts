/**
 * Shared helpers for the Worker's tests (the `workers` vitest project).
 *
 * Tests run inside workerd against the bindings from wrangler.toml, so `env.DB`
 * is a real (local) D1 database with the migrations applied. Storage is
 * isolated per test file; `resetStorage()` isolates tests within a file.
 *
 * Mocking strategy: `vi.mock()` does not reliably replace a module for its
 * transitive importers inside the workerd pool (it works for the test file's
 * own imports only), so tests do not use it. Instead:
 *  - outbound HTTP: `mockFetch()` stubs the global `fetch`
 *  - web push: `stubWebPush()` spies on the shared `web-push` object
 *  - queue / AI bindings: `testEnv()` swaps them for in-memory fakes
 */
import {env} from 'cloudflare:workers'
import {vi} from 'vitest'
import webpush, {type SendResult} from 'web-push'
import {type RawFeed, type RawFeedItem, type RawFeedSource, ServerFeed, ServerFeedItem, ServerFeedSource} from '../models'
import {type FeedProcessingTask} from '../types'

/******************************************************************************
 * Database
 *****************************************************************************/

const TABLES = [
    'notification', 'transcript', 'queue_item', 'feed_file', 'feed_source',
    'feed_item', 'feed', 'push_subscription', 'text_search',
]

/**
 * Empty every D1 table (and restart the AUTOINCREMENT counters) and the R2
 * bucket, typically from `beforeEach`.
 */
export async function resetStorage() {
    const db = env.DB
    await db.batch([
        ...TABLES.map(table => db.prepare(`DELETE FROM ${table}`)),
        db.prepare('DELETE FROM sqlite_sequence'),
    ])

    const bucket = env.RSS_CACHE_BUCKET
    const objects = await bucket.list()
    if (objects.objects.length > 0) {
        await bucket.delete(objects.objects.map(object => object.key))
    }
}

let sequence = 0
/** Monotonic counter so generated GUIDs and dates are unique within a file. */
export function nextSequence() {
    return ++sequence
}

/** ISO date `n` days after 2024-01-01; later sequence numbers sort later. */
export function dateAt(n: number) {
    return new Date(Date.UTC(2024, 0, 1) + n * 24 * 60 * 60 * 1000).toISOString()
}

export function rawFeed(overrides: Partial<RawFeed> = {}): RawFeed {
    const n = nextSequence()
    return {
        guid: `feed-${n}`,
        input_url: `https://example.com/feed-${n}`,
        source_url: `https://example.com/feed-${n}/rss`,
        title: `Feed ${n}`,
        alias: '',
        description: `Description of feed ${n}`,
        author: `Author ${n}`,
        type: 'blog',
        ongoing: true,
        active: true,
        image_src: null,
        image_alt: null,
        last_updated: dateAt(n),
        update_frequency: 1,
        link: `https://example.com/feed-${n}`,
        categories: '',
        notify_enabled: false,
        ...overrides,
    }
}

export async function seedFeed(overrides: Partial<RawFeed> = {}, db: D1Database = env.DB) {
    const feed = new ServerFeed(rawFeed(overrides))
    await feed.persistTo(db)
    return feed
}

export function rawFeedItem(sourceFeed: string, overrides: Partial<RawFeedItem> = {}): RawFeedItem {
    const n = nextSequence()
    return {
        guid: `item-${n}`,
        source_feed: sourceFeed,
        season: null,
        episode: null,
        title: `Item ${n}`,
        description: `Description of item ${n}`,
        link: `https://example.com/items/${n}`,
        date: dateAt(n),
        enclosure_url: null,
        enclosure_length: null,
        enclosure_type: null,
        duration: null,
        duration_unit: null,
        encoded_content: `<p>Content of item ${n}</p>`,
        keywords: '',
        finished: false,
        progress: 0,
        bookmarked: false,
        content_hash: null,
        ...overrides,
    }
}

export async function seedFeedItem(sourceFeed: string, overrides: Partial<RawFeedItem> = {}, db: D1Database = env.DB) {
    const item = new ServerFeedItem(rawFeedItem(sourceFeed, overrides))
    await item.persistTo(db)
    return item
}

export function rawFeedSource(referencedFeed: string, overrides: Partial<RawFeedSource> = {}): RawFeedSource {
    const n = nextSequence()
    return {
        feed_url: `https://example.com/source-${n}/rss`,
        referenced_feed: referencedFeed,
        actively_updating: true,
        last_updated: dateAt(n),
        last_fetched: dateAt(n),
        archive: false,
        primary_source: false,
        ...overrides,
    }
}

export async function seedFeedSource(referencedFeed: string, overrides: Partial<RawFeedSource> = {}, db: D1Database = env.DB) {
    const source = new ServerFeedSource(rawFeedSource(referencedFeed, overrides))
    await source.persistTo(db)
    return source
}

export async function countRows(table: string, db: D1Database = env.DB) {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{count: number}>()
    return row?.count ?? 0
}

/******************************************************************************
 * Bindings
 *****************************************************************************/

export interface SentMessage {
    body: FeedProcessingTask
    options?: QueueSendOptions
}

/** In-memory stand-in for the FEED_PROCESSING_QUEUE producer binding. */
export function fakeQueue() {
    const messages: SentMessage[] = []
    const queue = {
        messages,
        send: vi.fn((body: FeedProcessingTask, options?: QueueSendOptions) => {
            messages.push({body, options})
            return Promise.resolve()
        }),
        sendBatch: vi.fn((batch: Iterable<{body: FeedProcessingTask}>) => {
            for (const message of batch) messages.push({body: message.body})
            return Promise.resolve()
        }),
    }
    return queue
}

export type FakeQueue = ReturnType<typeof fakeQueue>

/**
 * The real test bindings with the queue producer replaced by an in-memory fake
 * (so tests can assert on enqueued tasks), plus any per-test overrides.
 */
export function testEnv(overrides: Partial<Env> = {}) {
    const queue = fakeQueue()
    return {
        env: {...env, FEED_PROCESSING_QUEUE: queue as unknown as Queue, ...overrides} as Env,
        queue,
    }
}

/**
 * Replace `webpush.sendNotification` with a spy (restored by
 * `vi.restoreAllMocks()`). push.ts calls it through the shared default export,
 * so the spy is visible to production code without module mocking.
 */
export function stubWebPush(implementation?: (...args: Parameters<typeof webpush.sendNotification>) => Promise<SendResult>) {
    const spy = vi.spyOn(webpush, 'sendNotification')
    if (implementation) {
        spy.mockImplementation(implementation)
    } else {
        spy.mockResolvedValue({statusCode: 201, body: '', headers: {}})
    }
    return spy
}

/******************************************************************************
 * fetch
 *****************************************************************************/

export type FetchRoute = Response | ((request: Request) => Response | Promise<Response>)

/**
 * Replace the global `fetch` with a router keyed by exact URL (or a predicate).
 * Requests to unknown URLs reject, so a test never silently hits the network.
 * Call `vi.unstubAllGlobals()` (e.g. in `afterEach`) to restore the real fetch.
 */
export function mockFetch(routes: Record<string, FetchRoute> | ((request: Request) => Response | Promise<Response> | undefined)) {
    const calls: Request[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        calls.push(request)
        const route = typeof routes === 'function' ? routes(request) : routes[request.url]
        if (route === undefined) {
            throw new Error(`Unexpected fetch: ${request.method} ${request.url}`)
        }
        const response = await (typeof route === 'function' ? route(request) : route)
        // Bodies can only be read once; hand each call its own copy.
        return response.clone()
    })
    vi.stubGlobal('fetch', fetchMock)
    return {fetchMock, calls}
}

/******************************************************************************
 * RSS documents
 *****************************************************************************/

export interface RssItemSpec {
    guid: string
    title: string
    description?: string
    link?: string
    pubDate?: string
    content?: string
    enclosure?: {url: string, length?: number, type?: string}
    duration?: string
}

export interface RssSpec {
    title: string
    guid?: string
    link?: string
    selfLink?: string
    description?: string
    podcast?: boolean
    items: RssItemSpec[]
}

function escapeXml(text: string) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Build a minimal RSS 2.0 document that parseRssText() understands. */
export function buildRss(spec: RssSpec) {
    const items = spec.items.map(item => `
    <item>
      <guid>${escapeXml(item.guid)}</guid>
      <title>${escapeXml(item.title)}</title>
      ${item.description !== undefined ? `<description>${escapeXml(item.description)}</description>` : ''}
      <link>${escapeXml(item.link ?? `https://example.com/items/${item.guid}`)}</link>
      ${item.pubDate !== undefined ? `<pubDate>${item.pubDate}</pubDate>` : ''}
      ${item.content !== undefined ? `<content:encoded><![CDATA[${item.content}]]></content:encoded>` : ''}
      ${item.enclosure ? `<enclosure url="${item.enclosure.url}" length="${item.enclosure.length ?? 1000}" type="${item.enclosure.type ?? 'audio/mpeg'}" />` : ''}
      ${item.duration !== undefined ? `<itunes:duration>${item.duration}</itunes:duration>` : ''}
    </item>`).join('')

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:podcast="https://podcastindex.org/namespace/1.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${escapeXml(spec.title)}</title>
  ${spec.guid !== undefined ? `<guid>${escapeXml(spec.guid)}</guid>` : ''}
  ${spec.selfLink !== undefined ? `<atom:link href="${spec.selfLink}" rel="self" type="application/rss+xml" />` : ''}
  <link>${escapeXml(spec.link ?? 'https://example.com')}</link>
  <description>${escapeXml(spec.description ?? `${spec.title} description`)}</description>
  ${spec.podcast ? '<itunes:author>Podcast Author</itunes:author>' : ''}
  ${items}
</channel>
</rss>`
}
