import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {buildRss, mockFetch, type FetchRoute} from '../testing/fixtures'
import {sha256Encode} from './crypto'
import {fetchRssFile} from './fetch-rss'
import {FETCH_USER_AGENT} from './files'

const FEED_URL = 'https://example.com/feed.xml'
const PAGE_URL = 'https://example.com/'

const RSS = buildRss({title: 'Example', guid: 'example', items: [{guid: 'a', title: 'A'}]})

const PAGE_WITH_LINK = `<!DOCTYPE html><html><head>
    <title>Example</title>
    <link rel="alternate" type="application/rss+xml" href="${FEED_URL}">
</head><body><p>Hello</p></body></html>`

const PAGE_WITHOUT_LINK = `<!DOCTYPE html><html><head><title>Example</title></head><body><p>Hello</p></body></html>`

const CHALLENGE_PAGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><script>window._cf_chl_opt = {};</script></body></html>`

const rss = () => new Response(RSS, {headers: {'content-type': 'application/rss+xml'}})
const html = (body: string, status = 200) => new Response(body, {status, headers: {'content-type': 'text/html'}})

/** Route by URL and, for the HTML fallback request, by its `Accept: text/html` header. */
function routes(table: Record<string, FetchRoute | {rss: FetchRoute, html: FetchRoute}>) {
    return mockFetch(request => {
        const route = table[request.url]
        if (route === undefined) return undefined
        if (route instanceof Response || typeof route === 'function') return typeof route === 'function' ? route(request) : route
        const fallback = request.headers.get('accept') === 'text/html'
        const selected = fallback ? route.html : route.rss
        return typeof selected === 'function' ? selected(request) : selected
    })
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('fetchRssFile', () => {
    test('returns the feed text with its metadata', async () => {
        const {calls} = mockFetch({[FEED_URL]: new Response(RSS, {headers: {date: 'Mon, 01 Jan 2024 00:00:00 GMT'}})})

        const result = await fetchRssFile(FEED_URL)

        expect(result).toEqual({
            status: 'success',
            content: RSS,
            metadata: {
                timestamp: 'Mon, 01 Jan 2024 00:00:00 GMT',
                requestUrl: FEED_URL,
                sha256Hash: await sha256Encode(RSS),
            },
        })
        expect(calls).toHaveLength(1)
        expect(calls[0].headers.get('accept'))
            .toBe('application/rss+xml, application/rdf+xml;q=0.8, application/atom+xml;q=0.6, application/xml;q=0.4, text/xml;q=0.4')
        expect(calls[0].headers.get('user-agent')).toBe(FETCH_USER_AGENT)
    })

    test('falls back to the current time when the response has no date header', async () => {
        mockFetch({[FEED_URL]: rss()})

        const result = await fetchRssFile(FEED_URL)

        expect(result.status).toBe('success')
        if (result.status === 'success') {
            expect(result.metadata.timestamp).toEqual(expect.any(String))
            expect(result.metadata.timestamp.length).toBeGreaterThan(0)
        }
    })

    describe('when the response is an HTML page', () => {
        test('reports a bot challenge page without fetching again', async () => {
            const {calls} = mockFetch({[PAGE_URL]: html(CHALLENGE_PAGE)})

            expect(await fetchRssFile(PAGE_URL)).toEqual({status: 'error', content: null, reason: 'blocked-by-bot-protection'})
            expect(calls).toHaveLength(1)
        })

        test('follows the RSS link in the page head', async () => {
            const {calls} = mockFetch({[PAGE_URL]: html(PAGE_WITH_LINK), [FEED_URL]: rss()})

            const result = await fetchRssFile(PAGE_URL)

            expect(result.status).toBe('success')
            if (result.status === 'success') {
                expect(result.content).toBe(RSS)
                expect(result.metadata.requestUrl).toBe(FEED_URL)
            }
            expect(calls.map(c => c.url)).toEqual([PAGE_URL, FEED_URL])
        })

        test('without a link, refetches as HTML and follows the link found there', async () => {
            const {calls} = routes({
                [PAGE_URL]: {rss: html(PAGE_WITHOUT_LINK), html: html(PAGE_WITH_LINK)},
                [FEED_URL]: rss(),
            })

            const result = await fetchRssFile(PAGE_URL)

            expect(result.status).toBe('success')
            expect(calls.map(c => c.url)).toEqual([PAGE_URL, PAGE_URL, FEED_URL])
            expect(calls[1].headers.get('accept')).toBe('text/html')
            expect(calls[1].headers.get('user-agent')).toBe(FETCH_USER_AGENT)
        })

        test('reports a bot challenge on the HTML fallback', async () => {
            routes({[PAGE_URL]: {rss: html(PAGE_WITHOUT_LINK), html: html(CHALLENGE_PAGE)}})

            expect(await fetchRssFile(PAGE_URL)).toEqual({status: 'error', content: null, reason: 'blocked-by-bot-protection'})
        })

        test('reports no-rss-link-found when neither page links a feed', async () => {
            const {calls} = routes({[PAGE_URL]: {rss: html(PAGE_WITHOUT_LINK), html: html(PAGE_WITHOUT_LINK)}})

            expect(await fetchRssFile(PAGE_URL)).toEqual({status: 'error', content: null, reason: 'no-rss-link-found'})
            expect(calls).toHaveLength(2)
        })
    })

    describe('when the first response is not ok', () => {
        test('follows the RSS link from the HTML fallback', async () => {
            const {calls} = routes({
                [PAGE_URL]: {rss: html('Not found', 404), html: html(PAGE_WITH_LINK)},
                [FEED_URL]: rss(),
            })

            const result = await fetchRssFile(PAGE_URL)

            expect(result.status).toBe('success')
            if (result.status === 'success') expect(result.metadata.requestUrl).toBe(FEED_URL)
            expect(calls.map(c => c.url)).toEqual([PAGE_URL, PAGE_URL, FEED_URL])
        })

        test('reports the upstream status when the fallback has no link', async () => {
            routes({[PAGE_URL]: {rss: html('Not found', 404), html: html(PAGE_WITHOUT_LINK)}})

            expect(await fetchRssFile(PAGE_URL)).toEqual({status: 'error', content: null, reason: 'upstream-error-404'})
        })

        test('reports the upstream status when the fallback is not ok either', async () => {
            routes({[PAGE_URL]: {rss: html('Server error', 500), html: html('Server error', 502)}})

            expect(await fetchRssFile(PAGE_URL)).toEqual({status: 'error', content: null, reason: 'upstream-error-500'})
        })
    })

    test('rewrites known site URLs to their feed URL before fetching', async () => {
        const {calls} = mockFetch({'https://medium.com/feed/@user': rss()})

        const result = await fetchRssFile('https://medium.com/@user')

        expect(result.status).toBe('success')
        if (result.status === 'success') expect(result.metadata.requestUrl).toBe('https://medium.com/feed/@user')
        expect(calls.map(c => c.url)).toEqual(['https://medium.com/feed/@user'])
    })
})
