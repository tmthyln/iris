import {hc} from 'hono/client'
import type {ClientRequestOptions, ClientResponse} from 'hono/client'
import type {SuccessStatusCode} from 'hono/utils/http-status'
import type {AppType} from './services/endpoints'
import type {ApiResult, FeedItemUpdate, FeedUpdate} from './types.ts'

const TIMEOUT_MS = 10000

// The deployed app sits behind Cloudflare Access. This header asks Access to
// answer an expired session with 401 instead of a redirect to its login page —
// but that is not reliable (a fully absent session still gets the redirect),
// so apiFetch additionally detects the redirect itself via redirect: 'manual'.
// https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#ajax
const ACCESS_AJAX_HEADER = ['X-Requested-With', 'XMLHttpRequest'] as const

// Query param appended when navigating to re-authenticate; the router strips it.
export const REAUTH_PARAM = 'reauth'

let reauthenticating = false

// The Worker has no auth of its own, so a 401 — or a redirect towards the
// Access login page — can only come from Cloudflare Access. Re-authenticate by
// navigating the document: Access logs the user in (silently if the global
// session is still valid) and redirects back here. The throwaway query param
// keeps the URL out of the service worker's precache, which would otherwise
// serve index.html without the request ever reaching Access.
function reauthenticate() {
    if (reauthenticating) return
    reauthenticating = true
    const url = new URL(window.location.href)
    url.searchParams.set(REAUTH_PARAM, Date.now().toString())
    window.location.assign(url.toString())
}

// fetch() for same-origin API calls. Adds the Access header and re-authenticates
// when the Access session has expired; all other handling is left to the
// caller. Also the fetch behind `rpc`.
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set(...ACCESS_AJAX_HEADER)
    // An expired session can also surface as a redirect to Access's
    // (cross-origin) login page; following it from fetch() would only fail
    // CORS and look like a network error. With 'manual' the redirect comes
    // back as an opaqueredirect response instead — and since the API never
    // redirects, any redirect here means the session is gone.
    const response = await fetch(input, {...init, headers, redirect: 'manual'})
    if (response.status === 401 || response.type === 'opaqueredirect') reauthenticate()
    return response
}

// Typed client for the Worker's routes (src/services/endpoints.ts). Paths,
// params, query strings, JSON bodies and response types all come from AppType.
const rpc = hc<AppType>('/', {fetch: apiFetch})

/** The JSON body of a call's 2xx response(s). */
type SuccessJson<R> = R extends ClientResponse<infer T, infer S, 'json'>
    ? (S extends SuccessStatusCode ? T : never)
    : never

type RpcCall<R> = (options: ClientRequestOptions) => Promise<R>

interface RequestOptions {
    /** 'none' for endpoints that respond with an empty body on success. */
    parse?: 'json' | 'none'
    timeoutMs?: number
}

// Runs one RPC call and folds the outcome into an ApiResult: the parsed 2xx
// body, the server's {error} message, or a timeout/offline error.
function request<R extends ClientResponse<unknown>>(call: RpcCall<R>, options?: RequestOptions & {parse?: 'json'}): Promise<ApiResult<SuccessJson<R>>>
function request<R extends ClientResponse<unknown>>(call: RpcCall<R>, options: RequestOptions & {parse: 'none'}): Promise<ApiResult<void>>
async function request<R extends ClientResponse<unknown>>(
    call: RpcCall<R>,
    {parse = 'json', timeoutMs = TIMEOUT_MS}: RequestOptions = {},
): Promise<ApiResult<SuccessJson<R> | void>> {
    try {
        const response = await call({init: {signal: AbortSignal.timeout(timeoutMs)}})
        if (response.ok) {
            const data = parse === 'json' ? await response.json() as SuccessJson<R> : undefined
            return {ok: true, status: response.status, data}
        }
        // Hono types status as the HTTP-code union, but an opaqueredirect is 0.
        const status: number = response.status
        if (status === 401 || status === 0) {
            // 401 from Access's AJAX handling, or its login redirect surfaced
            // as an opaqueredirect (status 0); apiFetch has begun re-auth.
            return {ok: false, status: 401, error: 'Session expired, signing in again'}
        }
        let error = `Server returned ${response.status}`
        try {
            const body = await response.json() as {error?: string} | null
            if (body?.error) error = body.error
        } catch { /* non-JSON error body */ }
        return {ok: false, status: response.status, error}
    } catch (err) {
        const timedOut = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')
        return {ok: false, status: null, error: timedOut ? 'Request timed out' : 'Network unavailable'}
    }
}

function unwrapItems<T>(result: ApiResult<{items: T[]}>): ApiResult<T[]> {
    return result.ok ? {...result, data: result.data.items} : result
}

// hc substitutes path params verbatim, and feed/item GUIDs are often URLs.
const param = (value: string) => encodeURIComponent(value)

interface PageOptions {
    limit?: number
    offset?: number
}

interface GetFeedItemsOptions extends PageOptions {
    bookmarked?: boolean
}

interface GetFeedFeedItemsOptions extends PageOptions {
    includeFinished?: boolean
    sortOrder?: 'asc' | 'desc'
}

const client = {
    getFeeds() {
        return request(o => rpc.api.feed.$get(undefined, o))
    },
    addFeed(url: string) {
        // Adding a feed fetches and parses the remote RSS file server-side,
        // which can take well beyond the default timeout.
        return request(o => rpc.api.feed.$post({json: {url}}, o), {parse: 'none', timeoutMs: 60000})
    },
    modifyFeed(feedGuid: string, updateData: FeedUpdate) {
        return request(o => rpc.api.feed[':guid'].$patch({param: {guid: param(feedGuid)}, json: updateData}, o), {parse: 'none'})
    },
    getFeedFeedItems(feedGuid: string, {includeFinished, sortOrder, limit, offset}: GetFeedFeedItemsOptions = {}) {
        return request(o => rpc.api.feed[':guid'].feeditem.$get({
            param: {guid: param(feedGuid)},
            query: {include_finished: includeFinished, sort_order: sortOrder, limit, offset},
        }, o))
    },
    getFeedItem(itemGuid: string) {
        return request(o => rpc.api.feeditem[':guid'].$get({param: {guid: param(itemGuid)}}, o))
    },
    getAdjacentFeedItems(itemGuid: string) {
        return request(o => rpc.api.feeditem[':guid'].adjacent.$get({param: {guid: param(itemGuid)}}, o))
    },
    getFeedItems({bookmarked, limit, offset = 0}: GetFeedItemsOptions = {}) {
        return request(o => rpc.api.feeditem.$get({query: {bookmarked: bookmarked || undefined, limit, offset}}, o))
    },
    modifyFeedItem(itemGuid: string, updateData: FeedItemUpdate) {
        return request(o => rpc.api.feeditem[':guid'].$patch({param: {guid: param(itemGuid)}, json: updateData}, o), {parse: 'none'})
    },
    searchFeedItems(query: string, {limit, offset = 0}: PageOptions = {}) {
        return request(o => rpc.api.search.$get({query: {q: query, limit, offset}}, o))
    },
    async getQueue() {
        return unwrapItems(await request(o => rpc.api.queue.$get(undefined, o)))
    },
    async queueFeedItem(feedItemGuid: string, position?: number) {
        return unwrapItems(await request(o => rpc.api.queue.$post({json: {feedItemId: feedItemGuid, position}}, o)))
    },
    async moveQueueItem(feedItemGuid: string, position: number) {
        return unwrapItems(await request(o => rpc.api.queue[':guid'].$patch({param: {guid: param(feedItemGuid)}, json: {position}}, o)))
    },
    async removeQueueItem(feedItemGuid: string) {
        return unwrapItems(await request(o => rpc.api.queue[':guid'].$delete({param: {guid: param(feedItemGuid)}}, o)))
    },
    async clearQueue(keepFirst: boolean) {
        return unwrapItems(await request(o => rpc.api.queue.$delete({query: {keepFirst: keepFirst || undefined}}, o)))
    },
    refreshFeed(feedGuid: string) {
        return request(o => rpc.api.command['refresh-feed'][':guid'].$post({param: {guid: param(feedGuid)}}, o), {parse: 'none'})
    },
    planFeedArchives(feedGuid: string) {
        return request(o => rpc.api.command['plan-feed-archives'][':guid'].$post({param: {guid: param(feedGuid)}}, o), {parse: 'none'})
    },
    refreshAllFeeds() {
        // Refreshes every feed inline on the server; this can take a while.
        return request(o => rpc.api.command['refresh-all-feeds'].$post(undefined, o), {timeoutMs: 120000})
    },
    getNotifications() {
        return request(o => rpc.api.notification.$get({query: {}}, o))
    },
    dismissNotification(id: number) {
        return request(o => rpc.api.notification[':id'].$delete({param: {id: String(id)}}, o), {parse: 'none'})
    },
    dismissAllNotifications() {
        return request(o => rpc.api.notification.$delete(undefined, o), {parse: 'none'})
    },
    async getVapidPublicKey(): Promise<ApiResult<string>> {
        const result = await request(o => rpc.api.push['vapid-public-key'].$get(undefined, o))
        return result.ok ? {...result, data: result.data.key} : result
    },
    registerPushSubscription(subscription: PushSubscriptionJSON): Promise<ApiResult<void>> {
        const {endpoint, keys} = subscription
        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            return Promise.resolve({ok: false, status: null, error: 'Push subscription is incomplete'})
        }
        const json = {endpoint, keys: {p256dh: keys.p256dh, auth: keys.auth}}
        return request(o => rpc.api.push.subscription.$post({json}, o), {parse: 'none'})
    },
    unregisterPushSubscription(endpoint: string) {
        return request(o => rpc.api.push.subscription.$delete({json: {endpoint}}, o), {parse: 'none'})
    },
    sendTestPushNotification(endpoint: string) {
        return request(o => rpc.api.push.test.$post({json: {endpoint}}, o), {parse: 'none'})
    },
    listTranscripts(itemGuid: string) {
        return request(o => rpc.api.feeditem[':guid'].transcript.$get({param: {guid: param(itemGuid)}}, o))
    },
    requestTranscript(itemGuid: string, opts: {model?: string, language?: string} = {}) {
        return request(o => rpc.api.feeditem[':guid'].transcript.$post({param: {guid: param(itemGuid)}, json: opts}, o))
    },
    getTranscript(transcriptId: number) {
        return request(o => rpc.api.transcript[':id'].$get({param: {id: String(transcriptId)}}, o))
    },
}

export default client

/******************************************************************************
 * Tests
 *****************************************************************************/

if (import.meta.vitest) {
    const {it, expect, describe, vi, afterEach} = import.meta.vitest

    describe('apiFetch', () => {
        afterEach(() => vi.unstubAllGlobals())

        it('sends the Cloudflare Access AJAX header and keeps redirects manual', async () => {
            const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', {status: 200})))
            vi.stubGlobal('fetch', fetchMock)
            await apiFetch('/api/feed', {headers: {'Content-Type': 'application/json'}})
            const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
            const headers = new Headers(init.headers)
            expect(headers.get('X-Requested-With')).toBe('XMLHttpRequest')
            expect(headers.get('Content-Type')).toBe('application/json')
            expect(init.redirect).toBe('manual')
        })

        it('navigates once to re-authenticate on an expired session, keeping the current URL', async () => {
            // First call: Access redirects to its login page (no session at
            // all — the header's AJAX-401 behaviour does not apply); second
            // call: Access answers 401. Both mean the session is gone.
            const loginRedirect = {type: 'opaqueredirect', status: 0, ok: false} as Response
            vi.stubGlobal('fetch', vi.fn()
                .mockResolvedValueOnce(loginRedirect)
                .mockResolvedValue(new Response(null, {status: 401})))
            const assign = vi.fn()
            vi.stubGlobal('window', {location: {href: 'https://iris.example/feed/abc?page=2#top', assign}})
            await apiFetch('/api/feed')
            await apiFetch('/api/queue')
            expect(assign).toHaveBeenCalledOnce()
            const target = new URL(assign.mock.calls[0][0] as string)
            expect(target.pathname).toBe('/feed/abc')
            expect(target.searchParams.get('page')).toBe('2')
            expect(target.searchParams.has(REAUTH_PARAM)).toBe(true)
            expect(target.hash).toBe('#top')
        })
    })

    describe('client', () => {
        afterEach(() => vi.unstubAllGlobals())

        function stubFetch(body: string, status = 200) {
            const fetchMock = vi.fn(() => Promise.resolve(new Response(body, {status, headers: {'Content-Type': 'application/json'}})))
            vi.stubGlobal('fetch', fetchMock)
            return () => {
                const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
                return {url: new URL(url, 'https://iris.example'), init, headers: new Headers(init.headers)}
            }
        }

        it('encodes path params (GUIDs are often URLs) and sends the Access header', async () => {
            const lastCall = stubFetch('{"guid":"https://example.com/a?b=1","title":"t"}')
            const result = await client.getFeedItem('https://example.com/a?b=1')
            const {url, headers} = lastCall()
            expect(url.pathname).toBe('/api/feeditem/https%3A%2F%2Fexample.com%2Fa%3Fb%3D1')
            expect(headers.get('X-Requested-With')).toBe('XMLHttpRequest')
            expect(result.ok && result.data.title).toBe('t')
        })

        it('serialises query params and JSON bodies', async () => {
            const lastCall = stubFetch('[]')
            await client.searchFeedItems('needle', {limit: 5})
            const {url} = lastCall()
            expect(url.pathname).toBe('/api/search')
            expect(Object.fromEntries(url.searchParams)).toEqual({q: 'needle', limit: '5', offset: '0'})

            const lastPost = stubFetch('', 200)
            const patched = await client.modifyFeedItem('g', {bookmarked: true})
            const {url: postUrl, init, headers} = lastPost()
            expect(patched.ok).toBe(true)
            expect(postUrl.pathname).toBe('/api/feeditem/g')
            expect(init.method).toBe('PATCH')
            expect(headers.get('Content-Type')).toBe('application/json')
            expect(init.body).toBe('{"bookmarked":true}')
        })

        it('maps an Access login redirect to the session-expired result', async () => {
            const loginRedirect = {type: 'opaqueredirect', status: 0, ok: false} as Response
            vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(loginRedirect)))
            vi.stubGlobal('window', {location: {href: 'https://iris.example/', assign: vi.fn()}})
            const result = await client.getFeeds()
            expect(result).toEqual({ok: false, status: 401, error: 'Session expired, signing in again'})
        })

        it('surfaces the server error message on failure', async () => {
            stubFetch('{"error":"No feed found with guid: x"}', 404)
            const result = await client.getFeeds()
            expect(result).toEqual({ok: false, status: 404, error: 'No feed found with guid: x'})
        })
    })
}
