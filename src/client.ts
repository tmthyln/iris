import {AdjacentFeedItems, ApiResult, Feed, FeedItem, FeedItemPreview, NotificationsResponse, Transcript, TranscriptFull} from "./types.ts";

interface SearchOptions {
    limit?: number
    offset?: number
}

interface GetFeedItemsOptionsBase {
    offset?: number
    limit?: number
}

interface GetBookmarkedFeedItemsOptions extends GetFeedItemsOptionsBase {
    bookmarked: true

}

interface GetRecentFeedItemsOptions extends GetFeedItemsOptionsBase {
    bookmarked?: false
}

type GetFeedItemsOptions = GetBookmarkedFeedItemsOptions | GetRecentFeedItemsOptions

interface FeedItemUpdateData {
    bookmarked?: boolean
    finished?: boolean
    progress?: number
}

const TIMEOUT_MS = 10000

// The deployed app sits behind Cloudflare Access. Without this header an
// expired Access session turns every API call into a cross-origin redirect to
// the login page, which fails CORS; with it, Access answers 401 instead.
// https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#ajax
const ACCESS_AJAX_HEADER = ['X-Requested-With', 'XMLHttpRequest'] as const

// Query param appended when navigating to re-authenticate; the router strips it.
export const REAUTH_PARAM = 'reauth'

let reauthenticating = false

// The Worker has no auth of its own, so a 401 can only come from Cloudflare
// Access. Re-authenticate by navigating the document: Access logs the user in
// (silently if the global session is still valid) and redirects back here. The
// throwaway query param keeps the URL out of the service worker's precache,
// which would otherwise serve index.html without the request reaching Access.
function reauthenticate() {
    if (reauthenticating) return
    reauthenticating = true
    const url = new URL(window.location.href)
    url.searchParams.set(REAUTH_PARAM, Date.now().toString())
    window.location.assign(url.toString())
}

// fetch() for same-origin API calls that need the raw Response (streaming,
// custom parsing). Adds the Access header and re-authenticates on 401; all
// other handling is left to the caller.
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set(...ACCESS_AJAX_HEADER)
    const response = await fetch(url, {...init, headers})
    if (response.status === 401) reauthenticate()
    return response
}

function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    return apiFetch(url, {...init, signal: controller.signal}).finally(() => clearTimeout(timer))
}

// Pass parse: 'none' for endpoints that respond with an empty body on success.
async function request<T = void>(
    url: string,
    init: RequestInit = {},
    parse: 'json' | 'none' = 'json',
    timeoutMs = TIMEOUT_MS,
): Promise<ApiResult<T>> {
    try {
        const response = await fetchWithTimeout(url, init, timeoutMs)
        if (response.ok) {
            const data = parse === 'json' ? await response.json() as T : undefined as T
            return {ok: true, status: response.status, data}
        }
        if (response.status === 401) {
            return {ok: false, status: response.status, error: 'Session expired, signing in again'}
        }
        let error = `Server returned ${response.status}`
        try {
            const body = await response.json() as {error?: string}
            if (body?.error) error = body.error
        } catch { /* non-JSON error body */ }
        return {ok: false, status: response.status, error}
    } catch (err) {
        const aborted = err instanceof DOMException && err.name === 'AbortError'
        return {ok: false, status: null, error: aborted ? 'Request timed out' : 'Network unavailable'}
    }
}

function unwrapItems(result: ApiResult<{items: FeedItemPreview[]}>): ApiResult<FeedItemPreview[]> {
    return result.ok ? {...result, data: result.data.items} : result
}

export default {
    getFeeds(): Promise<ApiResult<Feed[]>> {
        return request<Feed[]>('/api/feed')
    },
    addFeed(url: string): Promise<ApiResult<void>> {
        // Adding a feed fetches and parses the remote RSS file server-side,
        // which can take well beyond the default timeout.
        return request<void>('/api/feed', {
            method: 'POST',
            body: JSON.stringify({url}),
        }, 'none', 60000)
    },
    getFeedItem(itemGuid: string): Promise<ApiResult<FeedItem>> {
        return request<FeedItem>(`/api/feeditem/${encodeURIComponent(itemGuid)}`)
    },
    getAdjacentFeedItems(itemGuid: string): Promise<ApiResult<AdjacentFeedItems>> {
        return request<AdjacentFeedItems>(`/api/feeditem/${encodeURIComponent(itemGuid)}/adjacent`)
    },
    getFeedItems(options: GetFeedItemsOptions = {}): Promise<ApiResult<FeedItemPreview[]>> {
        const {
            bookmarked = null,
            limit = null,
            offset = 0,
        } = options

        const queryParams = new URLSearchParams()
        queryParams.set('offset', String(offset))
        limit && queryParams.set('limit', String(limit))
        bookmarked !== null && queryParams.set('bookmarked', String(bookmarked))

        return request<FeedItemPreview[]>(`/api/feeditem?${queryParams}`)
    },
    modifyFeed(feedGuid: string, updateData: { categories?: string[], alias?: string, notify_enabled?: boolean }): Promise<ApiResult<void>> {
        return request<void>(`/api/feed/${encodeURIComponent(feedGuid)}`, {
            method: 'PATCH',
            body: JSON.stringify(updateData),
        }, 'none')
    },
    modifyFeedItem(itemGuid: string, updateData: FeedItemUpdateData): Promise<ApiResult<void>> {
        return request<void>(`/api/feeditem/${encodeURIComponent(itemGuid)}`, {
            method: 'PATCH',
            body: JSON.stringify(updateData),
        }, 'none')
    },
    async queueFeedItem(feedItemGuid: string, position?: number): Promise<ApiResult<FeedItemPreview[]>> {
        return unwrapItems(await request<{items: FeedItemPreview[]}>('/api/queue', {
            method: 'POST',
            body: JSON.stringify({feedItemId: feedItemGuid, position}),
        }))
    },
    async moveQueueItem(feedItemGuid: string, position: number): Promise<ApiResult<FeedItemPreview[]>> {
        return unwrapItems(await request<{items: FeedItemPreview[]}>(`/api/queue/${encodeURIComponent(feedItemGuid)}`, {
            method: 'PATCH',
            body: JSON.stringify({position}),
        }))
    },
    async clearQueue(keepFirst: boolean): Promise<ApiResult<FeedItemPreview[]>> {
        const params = keepFirst ? '?keepFirst=true' : ''
        return unwrapItems(await request<{items: FeedItemPreview[]}>(`/api/queue${params}`, {
            method: 'DELETE',
        }))
    },
    async removeQueueItem(feedItemGuid: string): Promise<ApiResult<FeedItemPreview[]>> {
        return unwrapItems(await request<{items: FeedItemPreview[]}>(`/api/queue/${encodeURIComponent(feedItemGuid)}`, {
            method: 'DELETE',
        }))
    },
    refreshFeed(feedGuid: string): Promise<ApiResult<void>> {
        return request<void>(`/api/command/refresh-feed/${encodeURIComponent(feedGuid)}`, {
            method: 'POST',
        }, 'none')
    },
    searchFeedItems(query: string, options: SearchOptions = {}): Promise<ApiResult<FeedItemPreview[]>> {
        const { limit, offset = 0 } = options
        const queryParams = new URLSearchParams()
        queryParams.set('q', query)
        queryParams.set('offset', String(offset))
        limit && queryParams.set('limit', String(limit))

        return request<FeedItemPreview[]>(`/api/search?${queryParams}`)
    },
    planFeedArchives(feedGuid: string): Promise<ApiResult<void>> {
        return request<void>(`/api/command/plan-feed-archives/${encodeURIComponent(feedGuid)}`, {
            method: 'POST',
        }, 'none')
    },
    async getQueue(): Promise<ApiResult<FeedItemPreview[]>> {
        return unwrapItems(await request<{items: FeedItemPreview[]}>('/api/queue'))
    },
    getNotifications(): Promise<ApiResult<NotificationsResponse>> {
        return request<NotificationsResponse>('/api/notification')
    },
    dismissNotification(id: number): Promise<ApiResult<void>> {
        return request<void>(`/api/notification/${id}`, {method: 'DELETE'}, 'none')
    },
    dismissAllNotifications(): Promise<ApiResult<void>> {
        return request<void>('/api/notification', {method: 'DELETE'}, 'none')
    },
    async getVapidPublicKey(): Promise<ApiResult<string>> {
        const result = await request<{key: string}>('/api/push/vapid-public-key')
        return result.ok ? {...result, data: result.data.key} : result
    },
    registerPushSubscription(subscription: PushSubscriptionJSON): Promise<ApiResult<void>> {
        return request<void>('/api/push/subscription', {
            method: 'POST',
            body: JSON.stringify(subscription),
        }, 'none')
    },
    unregisterPushSubscription(endpoint: string): Promise<ApiResult<void>> {
        return request<void>('/api/push/subscription', {
            method: 'DELETE',
            body: JSON.stringify({endpoint}),
        }, 'none')
    },
    listTranscripts(itemGuid: string): Promise<ApiResult<Transcript[]>> {
        return request<Transcript[]>(`/api/feeditem/${encodeURIComponent(itemGuid)}/transcript`)
    },
    requestTranscript(itemGuid: string, opts: {model?: string, language?: string} = {}): Promise<ApiResult<Transcript>> {
        return request<Transcript>(`/api/feeditem/${encodeURIComponent(itemGuid)}/transcript`, {
            method: 'POST',
            body: JSON.stringify(opts),
        })
    },
    getTranscript(transcriptId: number): Promise<ApiResult<TranscriptFull>> {
        return request<TranscriptFull>(`/api/transcript/${transcriptId}`)
    },
    sendTestPushNotification(endpoint: string): Promise<ApiResult<void>> {
        return request<void>('/api/push/test', {
            method: 'POST',
            body: JSON.stringify({endpoint}),
        }, 'none')
    },
}

if (import.meta.vitest) {
    const {it, expect, describe, vi, afterEach} = import.meta.vitest

    describe('apiFetch', () => {
        afterEach(() => vi.unstubAllGlobals())

        it('sends the Cloudflare Access AJAX header', async () => {
            const fetchMock = vi.fn(async () => new Response('{}', {status: 200}))
            vi.stubGlobal('fetch', fetchMock)
            await apiFetch('/api/feed', {headers: {'Content-Type': 'application/json'}})
            const headers = new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers)
            expect(headers.get('X-Requested-With')).toBe('XMLHttpRequest')
            expect(headers.get('Content-Type')).toBe('application/json')
        })

        it('navigates once to re-authenticate on 401, keeping the current URL', async () => {
            vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {status: 401})))
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
}
