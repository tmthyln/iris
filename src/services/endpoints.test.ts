import {env as bindings} from 'cloudflare:workers'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {app} from './endpoints'
import {createNotification, createTranscriptRequest, updateTranscriptStatus} from './crud'
import {getQueue} from './queue'
import {TRANSCRIPT_DEFAULT_MODEL} from './flows'
import {FETCH_USER_AGENT} from './utils/files'
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
} from './testing/fixtures'

const db = bindings.DB

beforeEach(async () => {
    await resetStorage()
    await getQueue(bindings).clearQueue()
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

/******************************************************************************
 * Helpers
 *****************************************************************************/

function json(path: string, method: string, body: unknown, env: Env) {
    return app.request(path, {
        method,
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
    }, env)
}

function read<T>(response: Response) {
    return response.json() as Promise<T>
}

interface ErrorBody {
    error: string
}

interface Guided {
    guid: string
}

async function expectError(response: Response, status: number, error: string) {
    expect(response.status).toBe(status)
    expect(await read<ErrorBody>(response)).toEqual({error})
}

const PREVIEW_KEYS = [
    'bookmarked', 'date', 'description', 'duration', 'duration_unit', 'enclosure_length', 'enclosure_type',
    'enclosure_url', 'episode', 'finished', 'guid', 'keywords', 'link', 'progress', 'season', 'source_feed', 'title',
]

const CLIENT_TRANSCRIPT_KEYS = [
    'completed_at', 'error_message', 'feed_item_guid', 'id', 'language', 'model', 'requested_at',
    'source_transcript_id', 'started_at', 'status',
]

const rssHeaders = {'content-type': 'application/rss+xml', date: 'Mon, 01 Jan 2024 00:00:00 GMT'}

/******************************************************************************
 * Search
 *****************************************************************************/

describe('GET /api/search', () => {
    test('returns [] for queries shorter than 3 characters without touching the database', async () => {
        const {env} = testEnv({DB: {prepare() { throw new Error('should not query') }} as unknown as D1Database})

        for (const q of ['', 'ab', '  ab  ']) {
            const response = await app.request(`/api/search?q=${encodeURIComponent(q)}`, {}, env)
            expect(response.status).toBe(200)
            expect(await read<unknown[]>(response)).toEqual([])
        }
        const response = await app.request('/api/search', {}, env)
        expect(await read<unknown[]>(response)).toEqual([])
    })

    test('matches indexed content and returns previews', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a', title: 'Plain', encoded_content: '<p>Unique zebra content</p>'})
        await seedFeedItem('feed-a', {guid: 'item-b', title: 'Nothing to see'})
        const {env} = testEnv()

        const response = await app.request('/api/search?q=zebra', {}, env)
        expect(response.status).toBe(200)
        const results = await read<Record<string, unknown>[]>(response)
        expect(results.map(r => r.guid)).toEqual(['item-a'])
        expect(Object.keys(results[0]).sort()).toEqual(PREVIEW_KEYS)
        expect(results[0]).not.toHaveProperty('encoded_content')
    })

    test('escapes double quotes in the query', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a', title: 'She said "hello there"'})
        const {env} = testEnv()

        const response = await app.request(`/api/search?q=${encodeURIComponent('"hello')}`, {}, env)
        expect(response.status).toBe(200)
        expect((await read<Guided[]>(response)).map(r => r.guid)).toEqual(['item-a'])
    })

    test('applies limit and offset, defaulting when they are not numeric', async () => {
        await seedFeed({guid: 'feed-a'})
        for (const guid of ['item-a', 'item-b', 'item-c']) {
            await seedFeedItem('feed-a', {guid, title: 'Giraffe spotting'})
        }
        const {env} = testEnv()

        expect(await read<unknown[]>(await app.request('/api/search?q=giraffe&limit=2', {}, env))).toHaveLength(2)
        expect(await read<unknown[]>(await app.request('/api/search?q=giraffe&limit=2&offset=2', {}, env))).toHaveLength(1)
        expect(await read<unknown[]>(await app.request('/api/search?q=giraffe&limit=abc&offset=x', {}, env))).toHaveLength(3)
    })

    test('uses the first value of a repeated query parameter', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a', title: 'Giraffe spotting'})
        const {env} = testEnv()

        const response = await app.request('/api/search?q=giraffe&q=nomatch', {}, env)
        expect((await read<Guided[]>(response)).map(r => r.guid)).toEqual(['item-a'])
    })
})

/******************************************************************************
 * Feeds
 *****************************************************************************/

describe('GET /api/feed', () => {
    test('lists active feeds as client feeds', async () => {
        await seedFeed({guid: 'feed-a', input_url: 'https://secret', categories: 'x,y'})
        await seedFeed({guid: 'feed-b', active: false})
        const {env} = testEnv()

        const response = await app.request('/api/feed', {}, env)
        expect(response.status).toBe(200)
        const feeds = await read<Record<string, unknown>[]>(response)
        expect(feeds.map(f => f.guid)).toEqual(['feed-a'])
        expect(feeds[0]).not.toHaveProperty('input_url')
        expect(feeds[0]).toMatchObject({categories: ['x', 'y'], has_unread: false, has_archives: false})
        expect(typeof feeds[0].last_updated).toBe('string')
    })
})

describe('GET /api/feed/:guid', () => {
    test('returns the feed', async () => {
        await seedFeed({guid: 'feed-a', title: 'Hello'})
        const {env} = testEnv()

        const response = await app.request('/api/feed/feed-a', {}, env)
        expect(response.status).toBe(200)
        expect(await read<Record<string, unknown>>(response)).toMatchObject({guid: 'feed-a', title: 'Hello'})
    })

    test('round-trips a URL-encoded guid', async () => {
        const guid = 'https://example.com/feed?x=1&y=2'
        await seedFeed({guid})
        const {env} = testEnv()

        const response = await app.request(`/api/feed/${encodeURIComponent(guid)}`, {}, env)
        expect(response.status).toBe(200)
        expect((await read<Guided>(response)).guid).toBe(guid)
    })

    test('404s for an unknown guid', async () => {
        const {env} = testEnv()
        await expectError(await app.request('/api/feed/nope', {}, env), 404, 'No feed found with guid: nope')
    })
})

describe('POST /api/feed', () => {
    const url = 'https://example.com/blog'

    test('requires a url', async () => {
        const {env} = testEnv()
        await expectError(await app.request('/api/feed', {method: 'POST'}, env), 400, 'url is required')
        await expectError(await app.request('/api/feed', {method: 'POST', body: JSON.stringify({url}), headers: {'content-type': 'text/plain'}}, env), 400, 'url is required')
        await expectError(await json('/api/feed', 'POST', {}, env), 400, 'url is required')
        await expectError(await json('/api/feed', 'POST', {url: 42}, env), 400, 'url is required')
        await expectError(await json('/api/feed', 'POST', [url], env), 400, 'url is required')
    })

    test('502s with a specific message when the URL is behind bot protection', async () => {
        const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt = {};</script></body></html>'
        mockFetch({[url]: new Response(challenge, {headers: {'content-type': 'text/html'}})})
        const {env} = testEnv()

        await expectError(await json('/api/feed', 'POST', {url}, env), 502,
            'URL is protected by bot detection. Try providing the direct RSS feed URL instead.')
    })

    test('502s when no RSS link can be found', async () => {
        const html = '<!DOCTYPE html><html><head><title>No feed</title></head><body></body></html>'
        mockFetch({[url]: new Response(html, {headers: {'content-type': 'text/html'}})})
        const {env} = testEnv()

        await expectError(await json('/api/feed', 'POST', {url}, env), 502, 'No RSS feed found at the provided URL.')
    })

    test('502s with a generic message for upstream errors', async () => {
        mockFetch({[url]: new Response('down', {status: 500})})
        const {env} = testEnv()

        await expectError(await json('/api/feed', 'POST', {url}, env), 502, 'Provided URL was not accessible.')
    })

    test('refreshes an already-known feed source instead of re-importing it', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedSource('feed-a', {feed_url: url})
        mockFetch({[url]: new Response(buildRss({title: 'Blog', guid: 'feed-a', items: []}), {headers: rssHeaders})})
        const {env, queue} = testEnv()

        const response = await json('/api/feed', 'POST', {url}, env)
        expect(response.status).toBe(202)
        expect(await read<unknown>(response)).toEqual({message: 'Feed already exists, refreshing feed...'})
        expect(queue.messages.map(m => m.body)).toEqual([
            {type: 'refresh-feed', feedGuid: 'feed-a'},
            {type: 'plan-feed-archives', feedGuid: 'feed-a'},
        ])
        expect(await countRows('feed_file')).toBe(0)
        expect(await countRows('feed_item')).toBe(0)
    })

    test('imports a new feed with its source, cached file and items', async () => {
        const rss = buildRss({
            title: 'My Blog',
            guid: 'blog-guid',
            selfLink: 'https://example.com/blog/rss',
            items: [
                {guid: 'post-1', title: 'First', pubDate: 'Mon, 01 Jan 2024 00:00:00 GMT', content: '<p>Hello</p>'},
                {guid: 'post-2', title: 'Second', pubDate: 'Tue, 02 Jan 2024 00:00:00 GMT'},
            ],
        })
        const {calls} = mockFetch({[url]: new Response(rss, {headers: rssHeaders})})
        const {env, queue} = testEnv()

        const response = await json('/api/feed', 'POST', {url}, env)
        expect(response.status).toBe(200)
        expect(await read<unknown>(response)).toEqual({message: 'Feed loaded.'})
        expect(calls[0].headers.get('user-agent')).toBe(FETCH_USER_AGENT)

        const feed = await db.prepare('SELECT * FROM feed').first<Record<string, unknown>>()
        expect(feed).toMatchObject({guid: 'blog-guid', title: 'My Blog', input_url: url, source_url: 'https://example.com/blog/rss', type: 'blog'})

        const source = await db.prepare('SELECT * FROM feed_source').first<Record<string, unknown>>()
        expect(source).toMatchObject({feed_url: url, referenced_feed: 'blog-guid', archive: 0, actively_updating: 1})

        const file = await db.prepare('SELECT * FROM feed_file').first<{cached_file: string, referenced_feed: string, fetched_at: string}>()
        expect(file!.referenced_feed).toBe('blog-guid')
        expect(file!.fetched_at).toBe('2024-01-01T00:00:00.000Z')
        expect(await (await bindings.RSS_CACHE_BUCKET.get(file!.cached_file))!.text()).toBe(rss)

        const {results: items} = await db.prepare('SELECT guid, title, encoded_content FROM feed_item ORDER BY guid').all()
        expect(items).toEqual([
            {guid: 'post-1', title: 'First', encoded_content: '<p>Hello</p>'},
            {guid: 'post-2', title: 'Second', encoded_content: ''},
        ])

        expect(queue.messages.map(m => m.body)).toEqual([{type: 'plan-feed-archives', feedGuid: 'blog-guid'}])
    })

    test('adds a second source when the same content is served from another URL', async () => {
        const otherUrl = 'https://mirror.example.com/blog'
        const rss = buildRss({title: 'My Blog', guid: 'blog-guid', items: [{guid: 'post-1', title: 'First'}]})
        mockFetch({
            [url]: new Response(rss, {headers: rssHeaders}),
            [otherUrl]: new Response(rss, {headers: rssHeaders}),
        })
        const {env} = testEnv()

        expect((await json('/api/feed', 'POST', {url}, env)).status).toBe(200)
        expect((await json('/api/feed', 'POST', {url: otherUrl}, env)).status).toBe(200)

        expect(await countRows('feed')).toBe(1)
        expect(await countRows('feed_file')).toBe(1)
        const {results: sources} = await db.prepare('SELECT feed_url, referenced_feed FROM feed_source ORDER BY feed_url').all()
        expect(sources).toEqual([
            {feed_url: url, referenced_feed: 'blog-guid'},
            {feed_url: otherUrl, referenced_feed: 'blog-guid'},
        ])
    })
})

describe('PATCH /api/feed/:guid', () => {
    test('rejects bodies that are not objects', async () => {
        const {env} = testEnv()
        await expectError(await json('/api/feed/feed-a', 'PATCH', [1], env), 400, 'Request body must be a JSON object')
        await expectError(await json('/api/feed/feed-a', 'PATCH', 'x', env), 400, 'Request body must be a JSON object')
    })

    test('rejects unknown fields and invalid categories', async () => {
        const {env} = testEnv()
        await expectError(await json('/api/feed/feed-a', 'PATCH', {title: 'x'}, env), 422, 'Cannot update the feed field: title')
        await expectError(await json('/api/feed/feed-a', 'PATCH', {categories: 'x'}, env), 422, 'categories must be a list of strings')
        await expectError(await json('/api/feed/feed-a', 'PATCH', {categories: ['a', 1]}, env), 422, 'categories must be a list of strings')
        await expectError(await json('/api/feed/feed-a', 'PATCH', {categories: ['a,b']}, env), 422, 'Category names cannot contain commas')
    })

    test('an empty update is a no-op', async () => {
        await seedFeed({guid: 'feed-a', alias: 'keep'})
        const {env} = testEnv()

        const response = await json('/api/feed/feed-a', 'PATCH', {}, env)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('')
        expect((await db.prepare('SELECT alias FROM feed WHERE guid = ?').bind('feed-a').first<{alias: string}>())!.alias).toBe('keep')
    })

    test('persists categories, alias and notify_enabled', async () => {
        await seedFeed({guid: 'feed-a'})
        const {env} = testEnv()

        expect((await json('/api/feed/feed-a', 'PATCH', {categories: ['a', 'b'], alias: 'mine', notify_enabled: 'yes'}, env)).status).toBe(200)
        expect(await db.prepare('SELECT categories, alias, notify_enabled FROM feed WHERE guid = ?').bind('feed-a').first())
            .toEqual({categories: 'a,b', alias: 'mine', notify_enabled: 1})

        expect((await json('/api/feed/feed-a', 'PATCH', {alias: 5, notify_enabled: false}, env)).status).toBe(200)
        expect(await db.prepare('SELECT categories, alias, notify_enabled FROM feed WHERE guid = ?').bind('feed-a').first())
            .toEqual({categories: 'a,b', alias: '', notify_enabled: 0})
    })
})

describe('GET /api/feed/:guid/feeditem', () => {
    async function seed() {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b'})
        await seedFeedItem('feed-a', {guid: 'item-1'})
        await seedFeedItem('feed-a', {guid: 'item-2', finished: true})
        await seedFeedItem('feed-a', {guid: 'item-3'})
        await seedFeedItem('feed-b', {guid: 'item-other'})
    }

    test('lists unfinished items oldest first by default', async () => {
        await seed()
        const {env} = testEnv()

        const response = await app.request('/api/feed/feed-a/feeditem', {}, env)
        expect(response.status).toBe(200)
        const items = await read<Record<string, unknown>[]>(response)
        expect(items.map(i => i.guid)).toEqual(['item-1', 'item-3'])
        expect(items[0]).toHaveProperty('encoded_content')
    })

    test('honours include_finished, sort_order, limit and offset', async () => {
        await seed()
        const {env} = testEnv()

        const guids = async (query: string) =>
            (await read<Guided[]>(await app.request(`/api/feed/feed-a/feeditem?${query}`, {}, env))).map(i => i.guid)

        expect(await guids('include_finished=true')).toEqual(['item-1', 'item-2', 'item-3'])
        expect(await guids('include_finished=false')).toEqual(['item-1', 'item-3'])
        expect(await guids('include_finished=true&sort_order=desc')).toEqual(['item-3', 'item-2', 'item-1'])
        expect(await guids('include_finished=true&sort_order=sideways')).toEqual(['item-1', 'item-2', 'item-3'])
        expect(await guids('include_finished=true&limit=2')).toEqual(['item-1', 'item-2'])
        expect(await guids('include_finished=true&limit=2&offset=2')).toEqual(['item-3'])
    })
})

/******************************************************************************
 * Feed items
 *****************************************************************************/

describe('GET /api/feeditem', () => {
    async function seed() {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-inactive', active: false})
        await seedFeedItem('feed-a', {guid: 'item-1'})
        await seedFeedItem('feed-a', {guid: 'item-2', finished: true, bookmarked: true})
        await seedFeedItem('feed-a', {guid: 'item-3'})
        await seedFeedItem('feed-inactive', {guid: 'item-hidden'})
    }

    test('lists unfinished items of active feeds, newest first', async () => {
        await seed()
        const {env} = testEnv()

        const response = await app.request('/api/feeditem', {}, env)
        expect(response.status).toBe(200)
        expect((await read<Guided[]>(response)).map(i => i.guid)).toEqual(['item-3', 'item-1'])
    })

    test('bookmarked=true lists bookmarked items regardless of state', async () => {
        await seed()
        const {env} = testEnv()

        const response = await app.request('/api/feeditem?bookmarked=true', {}, env)
        expect((await read<Guided[]>(response)).map(i => i.guid)).toEqual(['item-2'])
    })

    test('applies limit and offset', async () => {
        await seed()
        const {env} = testEnv()

        expect((await read<Guided[]>(await app.request('/api/feeditem?limit=1', {}, env))).map(i => i.guid)).toEqual(['item-3'])
        expect((await read<Guided[]>(await app.request('/api/feeditem?limit=1&offset=1', {}, env))).map(i => i.guid)).toEqual(['item-1'])
    })
})

describe('GET /api/feeditem/:guid', () => {
    test('returns the full item or 404', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a', encoded_content: '<p>body</p>'})
        const {env} = testEnv()

        const response = await app.request('/api/feeditem/item-a', {}, env)
        expect(response.status).toBe(200)
        expect(await read<Record<string, unknown>>(response)).toMatchObject({guid: 'item-a', encoded_content: '<p>body</p>'})

        await expectError(await app.request('/api/feeditem/nope', {}, env), 404, 'No feed item found with guid: nope')
    })
})

describe('GET /api/feeditem/:guid/media', () => {
    test('404s when the item is missing or has no enclosure', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        const {env} = testEnv()

        await expectError(await app.request('/api/feeditem/nope/media', {}, env), 404, 'Feed item has no media enclosure')
        await expectError(await app.request('/api/feeditem/item-a/media', {}, env), 404, 'Feed item has no media enclosure')
    })

    test('502s for invalid or non-http enclosure URLs', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-bad', enclosure_url: 'not a url'})
        await seedFeedItem('feed-a', {guid: 'item-ftp', enclosure_url: 'ftp://example.com/x.mp3'})
        const {env} = testEnv()

        await expectError(await app.request('/api/feeditem/item-bad/media', {}, env), 502, 'Invalid media URL')
        await expectError(await app.request('/api/feeditem/item-ftp/media', {}, env), 502, 'Invalid media URL')
    })

    test('proxies the upstream body, status and whitelisted headers', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a', enclosure_url: 'https://cdn.example.com/ep.mp3'})
        const {calls} = mockFetch({
            'https://cdn.example.com/ep.mp3': new Response('audio', {
                status: 206,
                headers: {
                    'content-type': 'audio/mpeg',
                    'content-length': '5',
                    'accept-ranges': 'bytes',
                    'content-range': 'bytes 0-4/100',
                    'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
                    'etag': '"abc"',
                    'x-upstream-secret': 'nope',
                    'set-cookie': 'a=b',
                },
            }),
        })
        const {env} = testEnv()

        const response = await app.request('/api/feeditem/item-a/media', {headers: {range: 'bytes=0-4'}}, env)
        expect(response.status).toBe(206)
        expect(await response.text()).toBe('audio')
        expect(response.headers.get('content-type')).toBe('audio/mpeg')
        expect(response.headers.get('accept-ranges')).toBe('bytes')
        expect(response.headers.get('content-range')).toBe('bytes 0-4/100')
        expect(response.headers.get('last-modified')).toBe('Mon, 01 Jan 2024 00:00:00 GMT')
        expect(response.headers.get('etag')).toBe('"abc"')
        expect(response.headers.get('x-upstream-secret')).toBeNull()
        expect(response.headers.get('set-cookie')).toBeNull()

        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://cdn.example.com/ep.mp3')
        expect(calls[0].headers.get('user-agent')).toBe(FETCH_USER_AGENT)
        expect(calls[0].headers.get('range')).toBe('bytes=0-4')
    })

    test('does not forward a range header when the client sent none', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a', enclosure_url: 'https://cdn.example.com/ep.mp3'})
        const {calls} = mockFetch({'https://cdn.example.com/ep.mp3': new Response('audio', {headers: {'content-type': 'audio/mpeg'}})})
        const {env} = testEnv()

        const response = await app.request('/api/feeditem/item-a/media', {}, env)
        expect(response.status).toBe(200)
        expect(calls[0].headers.get('range')).toBeNull()
    })
})

describe('transcripts', () => {
    async function seedPodcastItem() {
        await seedFeed({guid: 'feed-a', type: 'podcast'})
        await seedFeedItem('feed-a', {guid: 'item-a', enclosure_url: 'https://cdn.example.com/ep.mp3'})
        await seedFeedItem('feed-a', {guid: 'item-silent'})
    }

    test('GET /api/feeditem/:guid/transcript lists transcript summaries', async () => {
        await seedPodcastItem()
        await createTranscriptRequest(db, 'item-a', 'm1')
        await createTranscriptRequest(db, 'item-a', 'm2', 'en')
        await createTranscriptRequest(db, 'item-silent', 'm1')
        const {env} = testEnv()

        const response = await app.request('/api/feeditem/item-a/transcript', {}, env)
        expect(response.status).toBe(200)
        const transcripts = await read<Record<string, unknown>[]>(response)
        expect(transcripts).toHaveLength(2)
        expect(transcripts.map(t => t.model).sort()).toEqual(['m1', 'm2'])
        expect(Object.keys(transcripts[0]).sort()).toEqual(CLIENT_TRANSCRIPT_KEYS)

        expect(await read<unknown[]>(await app.request('/api/feeditem/nope/transcript', {}, env))).toEqual([])
    })

    test('POST /api/feeditem/:guid/transcript validates the item', async () => {
        await seedPodcastItem()
        const {env, queue} = testEnv()

        await expectError(await json('/api/feeditem/nope/transcript', 'POST', {}, env), 404, 'No feed item found with guid: nope')
        await expectError(await json('/api/feeditem/item-silent/transcript', 'POST', {}, env), 400, 'Feed item has no audio enclosure')
        expect(queue.messages).toEqual([])
    })

    test('POST /api/feeditem/:guid/transcript creates a pending request and enqueues it', async () => {
        await seedPodcastItem()
        const {env, queue} = testEnv()

        const response = await app.request('/api/feeditem/item-a/transcript', {method: 'POST'}, env)
        expect(response.status).toBe(202)
        const transcript = await read<Record<string, unknown>>(response)
        expect(transcript).toMatchObject({id: 1, feed_item_guid: 'item-a', model: TRANSCRIPT_DEFAULT_MODEL, language: null, status: 'pending'})
        expect(Object.keys(transcript).sort()).toEqual(CLIENT_TRANSCRIPT_KEYS)
        expect(queue.messages.map(m => m.body)).toEqual([{type: 'transcribe-feed-item', transcriptId: 1}])
        expect(await db.prepare('SELECT status, model FROM transcript WHERE id = 1').first()).toEqual({status: 'pending', model: TRANSCRIPT_DEFAULT_MODEL})
    })

    test('POST /api/feeditem/:guid/transcript honours model and language', async () => {
        await seedPodcastItem()
        const {env, queue} = testEnv()

        const response = await json('/api/feeditem/item-a/transcript', 'POST', {model: 'custom', language: 'de'}, env)
        expect(response.status).toBe(202)
        expect(await read<Record<string, unknown>>(response)).toMatchObject({model: 'custom', language: 'de'})
        expect(queue.messages).toHaveLength(1)
    })

    test('POST /api/feeditem/:guid/transcript returns an active request instead of a duplicate', async () => {
        await seedPodcastItem()
        const {env, queue} = testEnv()

        const first = await read<{id: number}>(await json('/api/feeditem/item-a/transcript', 'POST', {model: 'custom'}, env))
        const second = await json('/api/feeditem/item-a/transcript', 'POST', {model: 'custom'}, env)
        expect(second.status).toBe(200)
        expect((await read<{id: number}>(second)).id).toBe(first.id)
        expect(queue.messages).toHaveLength(1)
        expect(await countRows('transcript')).toBe(1)

        // a different model is a new request
        expect((await json('/api/feeditem/item-a/transcript', 'POST', {model: 'other'}, env)).status).toBe(202)
        expect(await countRows('transcript')).toBe(2)
    })

    test('GET /api/transcript/:id returns the full transcript', async () => {
        await seedPodcastItem()
        const created = await createTranscriptRequest(db, 'item-a', 'm1')
        await updateTranscriptStatus(db, created.id, {status: 'complete', text: 'hello world', segments_json: '[]'})
        const {env} = testEnv()

        await expectError(await app.request('/api/transcript/abc', {}, env), 400, 'Invalid transcript id')
        await expectError(await app.request('/api/transcript/999', {}, env), 404, 'No transcript found with id: 999')

        const response = await app.request(`/api/transcript/${created.id}`, {}, env)
        expect(response.status).toBe(200)
        expect(await read<Record<string, unknown>>(response)).toMatchObject({id: created.id, status: 'complete', text: 'hello world', segments_json: '[]'})
    })
})

describe('GET /api/feeditem/:guid/adjacent', () => {
    test('returns the previous and next items of the same feed', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-1'})
        await seedFeedItem('feed-a', {guid: 'item-2'})
        await seedFeedItem('feed-a', {guid: 'item-3'})
        const {env} = testEnv()

        const middle = await read<{prev: Record<string, unknown> | null, next: Record<string, unknown> | null}>(
            await app.request('/api/feeditem/item-2/adjacent', {}, env))
        expect(middle.prev?.guid).toBe('item-1')
        expect(middle.next?.guid).toBe('item-3')
        expect(middle.prev).not.toHaveProperty('encoded_content')

        const first = await read<{prev: unknown, next: {guid: string} | null}>(await app.request('/api/feeditem/item-1/adjacent', {}, env))
        expect(first.prev).toBeNull()
        expect(first.next?.guid).toBe('item-2')

        expect(await read<unknown>(await app.request('/api/feeditem/nope/adjacent', {}, env))).toEqual({prev: null, next: null})
    })
})

describe('PATCH /api/feeditem/:guid', () => {
    test('validates the body', async () => {
        const {env} = testEnv()
        await expectError(await json('/api/feeditem/item-a', 'PATCH', 'nope', env), 400, 'Request body must be a JSON object')
        await expectError(await json('/api/feeditem/item-a', 'PATCH', {title: 'x'}, env), 422, 'Cannot update the feed item field: title')
        await expectError(await json('/api/feeditem/item-a', 'PATCH', {progress: '12'}, env), 422, 'progress must be a number')
        await expectError(await json('/api/feeditem/item-a', 'PATCH', {progress: null}, env), 422, 'progress must be a number')
    })

    test('an empty update is a no-op', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a', progress: 7})
        const {env} = testEnv()

        const response = await json('/api/feeditem/item-a', 'PATCH', {}, env)
        expect(response.status).toBe(200)
        expect(await db.prepare('SELECT progress FROM feed_item WHERE guid = ?').bind('item-a').first()).toEqual({progress: 7})
    })

    test('persists finished, progress and bookmarked', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        const {env} = testEnv()

        expect((await json('/api/feeditem/item-a', 'PATCH', {finished: 1, progress: 12.5, bookmarked: true}, env)).status).toBe(200)
        expect(await db.prepare('SELECT finished, progress, bookmarked FROM feed_item WHERE guid = ?').bind('item-a').first())
            .toEqual({finished: 1, progress: 12.5, bookmarked: 1})

        expect((await json('/api/feeditem/item-a', 'PATCH', {finished: false}, env)).status).toBe(200)
        expect(await db.prepare('SELECT finished, progress, bookmarked FROM feed_item WHERE guid = ?').bind('item-a').first())
            .toEqual({finished: 0, progress: 12.5, bookmarked: 1})
    })
})

/******************************************************************************
 * Queue
 *****************************************************************************/

describe('queue routes', () => {
    interface QueueBody {
        items: Record<string, unknown>[]
    }

    async function seedPodcast() {
        await seedFeed({guid: 'podcast', type: 'podcast'})
        await seedFeed({guid: 'blog', type: 'blog'})
        for (const guid of ['ep-1', 'ep-2', 'ep-3']) {
            await seedFeedItem('podcast', {guid, enclosure_url: `https://cdn.example.com/${guid}.mp3`})
        }
        await seedFeedItem('blog', {guid: 'post-1'})
    }

    async function queued(response: Response, status = 200) {
        expect(response.status).toBe(status)
        return (await read<QueueBody>(response)).items.map(i => i.guid)
    }

    test('GET /api/queue starts empty', async () => {
        const {env} = testEnv()
        expect(await queued(await app.request('/api/queue', {}, env))).toEqual([])
    })

    test('POST /api/queue validates the item', async () => {
        await seedPodcast()
        const {env} = testEnv()

        await expectError(await json('/api/queue', 'POST', {}, env), 400, 'feedItemId is required')
        await expectError(await json('/api/queue', 'POST', {feedItemId: 'nope'}, env), 404, 'No feed item found with id: nope')
        await expectError(await json('/api/queue', 'POST', {feedItemId: 'post-1'}, env), 400, 'Only podcast feed items can be queued')
        expect(await queued(await app.request('/api/queue', {}, env))).toEqual([])
    })

    test('POST /api/queue appends or inserts at a position and returns previews', async () => {
        await seedPodcast()
        const {env} = testEnv()

        expect(await queued(await json('/api/queue', 'POST', {feedItemId: 'ep-1'}, env), 201)).toEqual(['ep-1'])
        expect(await queued(await json('/api/queue', 'POST', {feedItemId: 'ep-2'}, env), 201)).toEqual(['ep-1', 'ep-2'])
        expect(await queued(await json('/api/queue', 'POST', {feedItemId: 'ep-3', position: 1}, env), 201)).toEqual(['ep-1', 'ep-3', 'ep-2'])

        const response = await app.request('/api/queue', {}, env)
        const {items} = await read<QueueBody>(response)
        expect(items.map(i => i.guid)).toEqual(['ep-1', 'ep-3', 'ep-2'])
        expect(Object.keys(items[0]).sort()).toEqual(PREVIEW_KEYS)
    })

    test('hydration skips queued guids whose item no longer exists', async () => {
        await seedPodcast()
        const {env} = testEnv()
        await json('/api/queue', 'POST', {feedItemId: 'ep-1'}, env)
        await json('/api/queue', 'POST', {feedItemId: 'ep-2'}, env)
        await db.prepare('DELETE FROM feed_item WHERE guid = ?').bind('ep-1').run()

        expect(await queued(await app.request('/api/queue', {}, env))).toEqual(['ep-2'])
        expect(await getQueue(bindings).getItems()).toEqual(['ep-1', 'ep-2'])
    })

    test('PATCH /api/queue/:guid moves an item', async () => {
        await seedPodcast()
        const {env} = testEnv()
        for (const feedItemId of ['ep-1', 'ep-2', 'ep-3']) await json('/api/queue', 'POST', {feedItemId}, env)

        await expectError(await json('/api/queue/ep-3', 'PATCH', {}, env), 400, 'position is required')
        await expectError(await json('/api/queue/ep-3', 'PATCH', {position: '0'}, env), 400, 'position is required')
        expect(await queued(await json('/api/queue/ep-3', 'PATCH', {position: 0}, env))).toEqual(['ep-3', 'ep-1', 'ep-2'])
    })

    test('DELETE /api/queue/:guid removes an item', async () => {
        await seedPodcast()
        const {env} = testEnv()
        for (const feedItemId of ['ep-1', 'ep-2']) await json('/api/queue', 'POST', {feedItemId}, env)

        expect(await queued(await app.request('/api/queue/ep-1', {method: 'DELETE'}, env))).toEqual(['ep-2'])
        expect(await queued(await app.request('/api/queue/missing', {method: 'DELETE'}, env))).toEqual(['ep-2'])
    })

    test('DELETE /api/queue clears everything or keeps the first item', async () => {
        await seedPodcast()
        const {env} = testEnv()
        for (const feedItemId of ['ep-1', 'ep-2', 'ep-3']) await json('/api/queue', 'POST', {feedItemId}, env)

        expect(await queued(await app.request('/api/queue?keepFirst=true', {method: 'DELETE'}, env))).toEqual(['ep-1'])
        expect(await queued(await app.request('/api/queue', {method: 'DELETE'}, env))).toEqual([])
        expect(await queued(await app.request('/api/queue?keepFirst=true', {method: 'DELETE'}, env))).toEqual([])
        expect(await getQueue(bindings).getItems()).toEqual([])
    })
})

/******************************************************************************
 * Commands
 *****************************************************************************/

describe('command routes', () => {
    test('refresh-feed enqueues a refresh task for a known feed', async () => {
        await seedFeed({guid: 'feed-a'})
        const {env, queue} = testEnv()

        await expectError(await app.request('/api/command/refresh-feed/nope', {method: 'POST'}, env), 404, 'No feed found with guid: nope')
        expect(queue.messages).toEqual([])

        const response = await app.request('/api/command/refresh-feed/feed-a', {method: 'POST'}, env)
        expect(response.status).toBe(202)
        expect(await response.text()).toBe('')
        expect(queue.messages.map(m => m.body)).toEqual([{type: 'refresh-feed', feedGuid: 'feed-a'}])
    })

    test('plan-feed-archives enqueues a planning task for a known feed', async () => {
        await seedFeed({guid: 'feed-a'})
        const {env, queue} = testEnv()

        await expectError(await app.request('/api/command/plan-feed-archives/nope', {method: 'POST'}, env), 404, 'No feed found with guid: nope')

        const response = await app.request('/api/command/plan-feed-archives/feed-a', {method: 'POST'}, env)
        expect(response.status).toBe(202)
        expect(queue.messages.map(m => m.body)).toEqual([{type: 'plan-feed-archives', feedGuid: 'feed-a'}])
    })

    test('refresh-all-feeds refreshes every active feed inline', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeed({guid: 'feed-b'})
        await seedFeed({guid: 'feed-inactive', active: false})
        const {env} = testEnv()

        const response = await app.request('/api/command/refresh-all-feeds', {method: 'POST'}, env)
        expect(response.status).toBe(200)
        expect(await read<unknown>(response)).toEqual({refreshedCount: 2})
    })
})

/******************************************************************************
 * Notifications
 *****************************************************************************/

describe('notification routes', () => {
    interface NotificationsBody {
        items: {id: number, type: string, feed_title: string | null, item_title: string | null, dismissed: boolean, created_at: string}[]
        unreadCount: number
    }

    async function seedNotifications() {
        await seedFeed({guid: 'feed-a', title: 'Feed A'})
        await seedFeedItem('feed-a', {guid: 'item-a', title: 'Item A'})
        await seedFeedItem('feed-a', {guid: 'item-b', title: 'Item B'})
        await db.batch([
            db.prepare(`INSERT INTO notification (type, feed_guid, feed_item_guid, created_at, dismissed) VALUES ('new_item', 'feed-a', 'item-a', ?, 0)`).bind(dateAt(1)),
            db.prepare(`INSERT INTO notification (type, feed_guid, feed_item_guid, created_at, dismissed) VALUES ('updated_item', 'feed-a', 'item-b', ?, 0)`).bind(dateAt(2)),
            db.prepare(`INSERT INTO notification (type, feed_guid, feed_item_guid, created_at, dismissed) VALUES ('new_item', 'feed-a', 'item-b', ?, 1)`).bind(dateAt(3)),
        ])
    }

    test('GET /api/notification lists undismissed notifications newest first with the unread count', async () => {
        await seedNotifications()
        const {env} = testEnv()

        const response = await app.request('/api/notification', {}, env)
        expect(response.status).toBe(200)
        const body = await read<NotificationsBody>(response)
        expect(body.unreadCount).toBe(2)
        expect(body.items.map(i => i.id)).toEqual([2, 1])
        expect(body.items[0]).toMatchObject({type: 'updated_item', feed_title: 'Feed A', item_title: 'Item B', dismissed: false, created_at: dateAt(2)})
    })

    test('GET /api/notification can include dismissed notifications and clamps the limit', async () => {
        await seedNotifications()
        const {env} = testEnv()

        const all = await read<NotificationsBody>(await app.request('/api/notification?include_dismissed=true', {}, env))
        expect(all.items.map(i => i.id)).toEqual([3, 2, 1])
        expect(all.items[0].dismissed).toBe(true)
        expect(all.unreadCount).toBe(2)

        expect((await read<NotificationsBody>(await app.request('/api/notification?limit=0', {}, env))).items).toHaveLength(1)
        expect((await read<NotificationsBody>(await app.request('/api/notification?limit=1', {}, env))).items.map(i => i.id)).toEqual([2])
        expect((await read<NotificationsBody>(await app.request('/api/notification?limit=999', {}, env))).items).toHaveLength(2)
    })

    test('DELETE /api/notification/:id dismisses one notification', async () => {
        await seedNotifications()
        const {env} = testEnv()

        await expectError(await app.request('/api/notification/abc', {method: 'DELETE'}, env), 400, 'Invalid notification id')

        const response = await app.request('/api/notification/1', {method: 'DELETE'}, env)
        expect(response.status).toBe(200)
        expect(await db.prepare('SELECT id FROM notification WHERE dismissed = FALSE').all().then(r => r.results)).toEqual([{id: 2}])
    })

    test('DELETE /api/notification dismisses everything', async () => {
        await seedNotifications()
        const {env} = testEnv()

        const response = await app.request('/api/notification', {method: 'DELETE'}, env)
        expect(response.status).toBe(200)
        expect((await read<NotificationsBody>(await app.request('/api/notification', {}, env))).unreadCount).toBe(0)
    })

    test('notifications created through crud appear in the list', async () => {
        await seedFeed({guid: 'feed-a'})
        await seedFeedItem('feed-a', {guid: 'item-a'})
        await createNotification(db, 'new_item', 'feed-a', 'item-a')
        const {env} = testEnv()

        const body = await read<NotificationsBody>(await app.request('/api/notification', {}, env))
        expect(body.items).toHaveLength(1)
        expect(body.unreadCount).toBe(1)
    })
})

/******************************************************************************
 * Push subscriptions
 *****************************************************************************/

describe('push routes', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc'
    const subscription = {endpoint, keys: {p256dh: 'p256dh-key', auth: 'auth-key'}}

    async function insertSubscriptions(count: number) {
        await db.batch(Array.from({length: count}, (_, i) =>
            db.prepare('INSERT INTO push_subscription (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)')
                .bind(`https://fcm.googleapis.com/fcm/send/${i}`, 'p', 'a', dateAt(1))))
    }

    test('GET /api/push/vapid-public-key returns the configured key or 503', async () => {
        const {env} = testEnv()
        const response = await app.request('/api/push/vapid-public-key', {}, env)
        expect(response.status).toBe(200)
        expect(await read<unknown>(response)).toEqual({key: 'test-vapid-public-key'})

        const {env: unconfigured} = testEnv({VAPID_PUBLIC_KEY: ''})
        await expectError(await app.request('/api/push/vapid-public-key', {}, unconfigured), 503, 'Push notifications not configured')
    })

    test('POST /api/push/subscription requires the subscription fields', async () => {
        const {env} = testEnv()
        const message = 'endpoint, keys.p256dh, and keys.auth are required'
        await expectError(await app.request('/api/push/subscription', {method: 'POST'}, env), 400, message)
        await expectError(await json('/api/push/subscription', 'POST', {endpoint}, env), 400, message)
        await expectError(await json('/api/push/subscription', 'POST', {endpoint, keys: {p256dh: 'p'}}, env), 400, message)
        await expectError(await json('/api/push/subscription', 'POST', {endpoint, keys: 'nope'}, env), 400, message)
        expect(await countRows('push_subscription')).toBe(0)
    })

    test('POST /api/push/subscription rejects endpoints that are not a known push service', async () => {
        const {env} = testEnv()
        const cases: [string, string][] = [
            ['https://fcm.googleapis.com/' + 'a'.repeat(2100), 'endpoint is too long'],
            ['not a url', 'endpoint is not a valid URL'],
            ['http://fcm.googleapis.com/fcm/send/abc', 'endpoint must be https'],
            ['https://evil.example.com/push', 'endpoint host is not a recognized push service'],
            ['https://fcm.googleapis.com.evil.example.com/push', 'endpoint host is not a recognized push service'],
        ]
        for (const [badEndpoint, message] of cases) {
            await expectError(await json('/api/push/subscription', 'POST', {...subscription, endpoint: badEndpoint}, env), 400, message)
        }
        expect(await countRows('push_subscription')).toBe(0)
    })

    test('POST /api/push/subscription rejects oversized keys', async () => {
        const {env} = testEnv()
        await expectError(await json('/api/push/subscription', 'POST', {endpoint, keys: {p256dh: 'a'.repeat(2049), auth: 'a'}}, env), 400, 'subscription key is too long')
        await expectError(await json('/api/push/subscription', 'POST', {endpoint, keys: {p256dh: 'a', auth: 'a'.repeat(2049)}}, env), 400, 'subscription key is too long')
    })

    test('POST /api/push/subscription accepts every supported push service', async () => {
        const {env} = testEnv()
        const endpoints = [
            'https://updates.push.services.mozilla.com/wpush/v2/abc',
            'https://fcm.googleapis.com/fcm/send/abc',
            'https://wns2-bn1p.notify.windows.com/w/?token=abc',
            'https://web.push.apple.com/abc',
            'https://pushservice.google.com/abc',
        ]
        for (const accepted of endpoints) {
            const response = await json('/api/push/subscription', 'POST', {...subscription, endpoint: accepted}, env)
            expect(response.status).toBe(201)
            expect(await response.text()).toBe('')
        }
        expect(await countRows('push_subscription')).toBe(endpoints.length)
        expect(await db.prepare('SELECT p256dh, auth FROM push_subscription WHERE endpoint = ?').bind(endpoint).first())
            .toEqual({p256dh: 'p256dh-key', auth: 'auth-key'})
    })

    test('POST /api/push/subscription caps the table but still updates existing rows', async () => {
        await insertSubscriptions(50)
        const {env} = testEnv()

        await expectError(await json('/api/push/subscription', 'POST', subscription, env), 429, 'subscription cap reached')
        expect(await countRows('push_subscription')).toBe(50)

        const existing = 'https://fcm.googleapis.com/fcm/send/0'
        expect((await json('/api/push/subscription', 'POST', {...subscription, endpoint: existing}, env)).status).toBe(201)
        expect(await countRows('push_subscription')).toBe(50)
        expect(await db.prepare('SELECT p256dh FROM push_subscription WHERE endpoint = ?').bind(existing).first()).toEqual({p256dh: 'p256dh-key'})
    })

    test('DELETE /api/push/subscription accepts the endpoint in the body or the query', async () => {
        await insertSubscriptions(2)
        const {env} = testEnv()

        await expectError(await app.request('/api/push/subscription', {method: 'DELETE'}, env), 400, 'endpoint is required')
        await expectError(await json('/api/push/subscription', 'DELETE', {}, env), 400, 'endpoint is required')

        const viaBody = await json('/api/push/subscription', 'DELETE', {endpoint: 'https://fcm.googleapis.com/fcm/send/0'}, env)
        expect(viaBody.status).toBe(200)
        expect(await countRows('push_subscription')).toBe(1)

        const viaQuery = await app.request(`/api/push/subscription?endpoint=${encodeURIComponent('https://fcm.googleapis.com/fcm/send/1')}`, {method: 'DELETE'}, env)
        expect(viaQuery.status).toBe(200)
        expect(await countRows('push_subscription')).toBe(0)
    })

    test('POST /api/push/test 503s when push is unconfigured or there are no subscribers', async () => {
        const {env} = testEnv()
        await expectError(await app.request('/api/push/test', {method: 'POST'}, env), 503, 'Push not configured or no subscribers')

        await insertSubscriptions(1)
        const {env: unconfigured} = testEnv({VAPID_PRIVATE_KEY: ''})
        await expectError(await app.request('/api/push/test', {method: 'POST'}, unconfigured), 503, 'Push not configured or no subscribers')
    })

    test('POST /api/push/test 404s when the endpoint filter matches nothing', async () => {
        await insertSubscriptions(1)
        const send = stubWebPush()
        const {env} = testEnv()

        await expectError(await json('/api/push/test', 'POST', {endpoint: 'https://fcm.googleapis.com/fcm/send/other'}, env), 404, 'No matching subscription')
        expect(send).not.toHaveBeenCalled()
    })

    test('POST /api/push/test sends a test notification to every subscriber', async () => {
        await insertSubscriptions(2)
        const send = stubWebPush()
        const {env} = testEnv()

        const response = await app.request('/api/push/test', {method: 'POST'}, env)
        expect(response.status).toBe(204)
        expect(send).toHaveBeenCalledTimes(2)
        const [target, payload, options] = send.mock.calls[0]
        expect(target).toEqual({endpoint: 'https://fcm.googleapis.com/fcm/send/0', keys: {p256dh: 'p', auth: 'a'}})
        expect(JSON.parse(payload as string)).toEqual({
            type: 'new_item', feed_guid: '', feed_item_guid: '', title: 'Iris', body: 'Test notification — push is working.', url: '/',
        })
        expect(options).toMatchObject({TTL: 86400, vapidDetails: {subject: 'mailto:test@example.com', publicKey: 'test-vapid-public-key', privateKey: 'test-vapid-private-key'}})
        expect(await countRows('push_subscription')).toBe(2)
        const {results} = await db.prepare('SELECT last_used_at FROM push_subscription').all<{last_used_at: string | null}>()
        expect(results.every(r => r.last_used_at !== null)).toBe(true)
    })

    test('POST /api/push/test can target a single subscription', async () => {
        await insertSubscriptions(2)
        const send = stubWebPush()
        const {env} = testEnv()

        const response = await json('/api/push/test', 'POST', {endpoint: 'https://fcm.googleapis.com/fcm/send/1'}, env)
        expect(response.status).toBe(204)
        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0][0]).toMatchObject({endpoint: 'https://fcm.googleapis.com/fcm/send/1'})
    })
})

/******************************************************************************
 * App-level behaviour
 *****************************************************************************/

describe('app', () => {
    test('unknown routes return a JSON 404', async () => {
        const {env} = testEnv()
        await expectError(await app.request('/api/nope', {}, env), 404, 'Not found')
        await expectError(await app.request('/api/feed/x/y/z', {}, env), 404, 'Not found')
    })

    test('malformed JSON bodies return a 400', async () => {
        const {env} = testEnv()
        const response = await app.request('/api/feed', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{bad json'}, env)
        expect(response.status).toBe(400)
        const body = await read<ErrorBody>(response)
        expect(typeof body.error).toBe('string')
        expect(body.error).toMatch(/JSON/)
    })

    test('unhandled errors return a JSON 500 and are logged', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const {env} = testEnv({DB: {prepare() { throw new Error('boom') }} as unknown as D1Database})

        await expectError(await app.request('/api/feed', {}, env), 500, 'Internal server error')
        expect(error).toHaveBeenCalledWith('Unhandled API error:', expect.any(Error))
    })
})
