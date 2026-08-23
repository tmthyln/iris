/**
 * Drives every `client` method against a stubbed global fetch, asserting the
 * wire format the Hono RPC client produces (paths, methods, query strings,
 * JSON bodies) and how responses fold into ApiResult. Complements the
 * in-source tests in client.ts, which cover apiFetch and the 401 re-auth.
 */
import {afterEach, describe, expect, it, vi} from 'vitest'
import client from './client.ts'

interface RecordedCall {
    url: URL
    method: string
    body: string | null
    headers: Headers
}

function stubFetch(body: unknown = null, status = 200) {
    const calls: RecordedCall[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        // hc passes relative string URLs, which the Request constructor rejects in Node.
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        calls.push({
            url: new URL(raw, 'http://localhost'),
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? init.body : null,
            headers: new Headers(init?.headers),
        })
        return Promise.resolve(new Response(
            body === null ? null : JSON.stringify(body),
            {status, headers: {'Content-Type': 'application/json'}},
        ))
    }))
    return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('feeds', () => {
    it('getFeeds → GET /api/feed', async () => {
        const calls = stubFetch([])
        const result = await client.getFeeds()
        expect(calls[0].method).toBe('GET')
        expect(calls[0].url.pathname).toBe('/api/feed')
        expect(result).toEqual({ok: true, status: 200, data: []})
    })

    it('addFeed → POST /api/feed with the URL, tolerating an empty body', async () => {
        const calls = stubFetch(null, 201)
        const result = await client.addFeed('https://example.com/rss')
        expect(calls[0].method).toBe('POST')
        expect(calls[0].url.pathname).toBe('/api/feed')
        expect(calls[0].body).toBe('{"url":"https://example.com/rss"}')
        expect(result).toEqual({ok: true, status: 201, data: undefined})
    })

    it('modifyFeed → PATCH /api/feed/:guid with the update', async () => {
        const calls = stubFetch()
        await client.modifyFeed('feed-1', {alias: 'New name'})
        expect(calls[0].method).toBe('PATCH')
        expect(calls[0].url.pathname).toBe('/api/feed/feed-1')
        expect(calls[0].body).toBe('{"alias":"New name"}')
    })

    it('getFeedFeedItems serialises the paging options, dropping undefined', async () => {
        const calls = stubFetch([])
        await client.getFeedFeedItems('feed-1', {includeFinished: true, sortOrder: 'asc', limit: 10})
        expect(calls[0].url.pathname).toBe('/api/feed/feed-1/feeditem')
        expect(Object.fromEntries(calls[0].url.searchParams))
            .toEqual({include_finished: 'true', sort_order: 'asc', limit: '10'})

        await client.getFeedFeedItems('feed-1')
        expect([...calls[1].url.searchParams]).toEqual([])
    })

    it('URL-encodes feed GUIDs that are themselves URLs', async () => {
        const calls = stubFetch()
        await client.modifyFeed('https://feeds.example/a?b=c', {alias: 'x'})
        expect(calls[0].url.pathname).toBe('/api/feed/https%3A%2F%2Ffeeds.example%2Fa%3Fb%3Dc')
    })
})

describe('feed items', () => {
    it('getFeedItems forwards paging and drops bookmarked=false', async () => {
        const calls = stubFetch([])
        await client.getFeedItems({bookmarked: false, limit: 20, offset: 40})
        expect(calls[0].url.pathname).toBe('/api/feeditem')
        expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({limit: '20', offset: '40'})

        await client.getFeedItems({bookmarked: true})
        expect(calls[1].url.searchParams.get('bookmarked')).toBe('true')
    })

    it('getAdjacentFeedItems → GET /api/feeditem/:guid/adjacent', async () => {
        const calls = stubFetch({prev: null, next: null})
        const result = await client.getAdjacentFeedItems('item-1')
        expect(calls[0].url.pathname).toBe('/api/feeditem/item-1/adjacent')
        expect(result.ok && result.data).toEqual({prev: null, next: null})
    })
})

describe('queue', () => {
    it('unwraps the {items} envelope on every queue call', async () => {
        stubFetch({items: [{guid: 'a'}]})
        const got = await client.getQueue()
        expect(got.ok && got.data).toEqual([{guid: 'a'}])

        stubFetch({items: []}, 201)
        const added = await client.queueFeedItem('item-1', 2)
        expect(added.ok && added.data).toEqual([])
    })

    it('sends the right verbs and payloads', async () => {
        let calls = stubFetch({items: []}, 201)
        await client.queueFeedItem('item-1', 0)
        expect(calls[0].method).toBe('POST')
        expect(calls[0].url.pathname).toBe('/api/queue')
        expect(calls[0].body).toBe('{"feedItemId":"item-1","position":0}')

        calls = stubFetch({items: []})
        await client.moveQueueItem('item-1', 3)
        expect(calls[0].method).toBe('PATCH')
        expect(calls[0].url.pathname).toBe('/api/queue/item-1')
        expect(calls[0].body).toBe('{"position":3}')

        calls = stubFetch({items: []})
        await client.removeQueueItem('item-1')
        expect(calls[0].method).toBe('DELETE')
        expect(calls[0].url.pathname).toBe('/api/queue/item-1')

        calls = stubFetch({items: []})
        await client.clearQueue(true)
        expect(calls[0].method).toBe('DELETE')
        expect(calls[0].url.pathname).toBe('/api/queue')
        expect(calls[0].url.searchParams.get('keepFirst')).toBe('true')

        calls = stubFetch({items: []})
        await client.clearQueue(false)
        expect(calls[0].url.searchParams.has('keepFirst')).toBe(false)
    })
})

describe('commands', () => {
    it('refreshFeed and planFeedArchives → POST /api/command/…/:guid', async () => {
        const calls = stubFetch(null, 202)
        await client.refreshFeed('feed-1')
        await client.planFeedArchives('feed-2')
        expect(calls[0].method).toBe('POST')
        expect(calls[0].url.pathname).toBe('/api/command/refresh-feed/feed-1')
        expect(calls[1].url.pathname).toBe('/api/command/plan-feed-archives/feed-2')
    })

    it('refreshAllFeeds parses the refresh summary', async () => {
        stubFetch({refreshedCount: 7})
        const result = await client.refreshAllFeeds()
        expect(result.ok && result.data).toEqual({refreshedCount: 7})
    })
})

describe('notifications', () => {
    it('covers list, dismiss and dismiss-all', async () => {
        let calls = stubFetch({items: [], unreadCount: 0})
        await client.getNotifications()
        expect(calls[0].url.pathname).toBe('/api/notification')

        calls = stubFetch()
        await client.dismissNotification(42)
        expect(calls[0].method).toBe('DELETE')
        expect(calls[0].url.pathname).toBe('/api/notification/42')

        calls = stubFetch()
        await client.dismissAllNotifications()
        expect(calls[0].method).toBe('DELETE')
        expect(calls[0].url.pathname).toBe('/api/notification')
    })
})

describe('push subscriptions', () => {
    it('getVapidPublicKey unwraps the key', async () => {
        stubFetch({key: 'vapid-abc'})
        const result = await client.getVapidPublicKey()
        expect(result).toEqual({ok: true, status: 200, data: 'vapid-abc'})
    })

    it('registerPushSubscription posts the subscription JSON', async () => {
        const calls = stubFetch(null, 201)
        const result = await client.registerPushSubscription({
            endpoint: 'https://push.example/e1',
            keys: {p256dh: 'p', auth: 'a'},
        })
        expect(result.ok).toBe(true)
        expect(calls[0].url.pathname).toBe('/api/push/subscription')
        expect(JSON.parse(calls[0].body!)).toEqual({endpoint: 'https://push.example/e1', keys: {p256dh: 'p', auth: 'a'}})
    })

    it('rejects an incomplete subscription without a request', async () => {
        const calls = stubFetch()
        const result = await client.registerPushSubscription({endpoint: 'https://push.example/e1'})
        expect(result).toEqual({ok: false, status: null, error: 'Push subscription is incomplete'})
        expect(calls).toHaveLength(0)
    })

    it('unregister and test-send address the endpoint by body', async () => {
        let calls = stubFetch()
        await client.unregisterPushSubscription('https://push.example/e1')
        expect(calls[0].method).toBe('DELETE')
        expect(calls[0].body).toBe('{"endpoint":"https://push.example/e1"}')

        calls = stubFetch()
        await client.sendTestPushNotification('https://push.example/e1')
        expect(calls[0].method).toBe('POST')
        expect(calls[0].url.pathname).toBe('/api/push/test')
    })
})

describe('transcripts', () => {
    it('covers list, request and fetch-by-id', async () => {
        let calls = stubFetch([])
        await client.listTranscripts('item-1')
        expect(calls[0].url.pathname).toBe('/api/feeditem/item-1/transcript')

        calls = stubFetch({id: 1}, 201)
        await client.requestTranscript('item-1', {model: 'whisper', language: 'en'})
        expect(calls[0].method).toBe('POST')
        expect(calls[0].body).toBe('{"model":"whisper","language":"en"}')

        calls = stubFetch({id: 5})
        await client.getTranscript(5)
        expect(calls[0].url.pathname).toBe('/api/transcript/5')
    })
})

describe('failure handling', () => {
    it('reports a plain status when the error body is not JSON', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html>oops</html>', {status: 502}))))
        const result = await client.getFeeds()
        expect(result).toEqual({ok: false, status: 502, error: 'Server returned 502'})
    })

    it('maps timeouts and network failures to friendly errors', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('timed out', 'TimeoutError'))))
        expect(await client.getFeeds()).toEqual({ok: false, status: null, error: 'Request timed out'})

        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))))
        expect(await client.getFeeds()).toEqual({ok: false, status: null, error: 'Network unavailable'})
    })
})
