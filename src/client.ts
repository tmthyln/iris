import {AdjacentFeedItems, Feed, FeedItem, FeedItemPreview, NotificationsResponse, Transcript, TranscriptFull} from "./types.ts";

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

function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    return fetch(url, {...init, signal: controller.signal}).finally(() => clearTimeout(timer))
}

export default {
    async getFeeds(): Promise<Feed[] | null> {
        try {
            const response = await fetchWithTimeout('/api/feed')
            if (response.ok) return await response.json() as Feed[]
            return null
        } catch {
            return null
        }
    },
    async getFeedItem(itemGuid: string) {
        try {
            const itemDataUrl = `/api/feeditem/${encodeURIComponent(itemGuid)}`
            const itemResponse = await fetchWithTimeout(itemDataUrl)
            if (itemResponse.ok) {
                const data: FeedItem = await itemResponse.json()
                return data
            }
            return null
        } catch {
            return null
        }
    },
    async getAdjacentFeedItems(itemGuid: string): Promise<AdjacentFeedItems | null> {
        try {
            const response = await fetchWithTimeout(`/api/feeditem/${encodeURIComponent(itemGuid)}/adjacent`)
            if (response.ok) return await response.json()
            return null
        } catch {
            return null
        }
    },
    async getFeedItems(options: GetFeedItemsOptions = {}) {
        try {
            const {
                bookmarked = null,
                limit = null,
                offset = 0,
            } = options

            const queryParams = new URLSearchParams()
            queryParams.set('offset', String(offset))
            limit && queryParams.set('limit', String(limit))
            bookmarked !== null && queryParams.set('bookmarked', String(bookmarked))

            const response = await fetchWithTimeout(`/api/feeditem?${queryParams}`)
            if (response.ok) {
                const data: FeedItemPreview[] = await response.json()
                return data
            }
            return null
        } catch {
            return null
        }
    },
    async modifyFeed(feedGuid: string, updateData: { categories?: string[], alias?: string, notify_enabled?: boolean }) {
        try {
            const response = await fetchWithTimeout(`/api/feed/${encodeURIComponent(feedGuid)}`, {
                method: 'PATCH',
                body: JSON.stringify(updateData),
            })
            return response.ok
        } catch {
            return false
        }
    },
    async modifyFeedItem(itemGuid: string, updateData: FeedItemUpdateData) {
        try {
            const response = await fetchWithTimeout(`/api/feeditem/${encodeURIComponent(itemGuid)}`, {
                method: 'PATCH',
                body: JSON.stringify(updateData),
            })
            return response.ok
        } catch {
            return false
        }
    },
    async queueFeedItem(feedItemGuid: string, position?: number): Promise<FeedItemPreview[] | null> {
        try {
            const response = await fetchWithTimeout('/api/queue', {
                method: 'POST',
                body: JSON.stringify({feedItemId: feedItemGuid, position}),
            })
            if (response.ok) {
                const data: {items: FeedItemPreview[]} = await response.json()
                return data.items
            }
            return null
        } catch {
            return null
        }
    },
    async moveQueueItem(feedItemGuid: string, position: number): Promise<FeedItemPreview[] | null> {
        try {
            const response = await fetchWithTimeout(`/api/queue/${encodeURIComponent(feedItemGuid)}`, {
                method: 'PATCH',
                body: JSON.stringify({position}),
            })
            if (response.ok) {
                const data: {items: FeedItemPreview[]} = await response.json()
                return data.items
            }
            return null
        } catch {
            return null
        }
    },
    async clearQueue(keepFirst: boolean): Promise<FeedItemPreview[] | null> {
        try {
            const params = keepFirst ? '?keepFirst=true' : ''
            const response = await fetchWithTimeout(`/api/queue${params}`, {
                method: 'DELETE',
            })
            if (response.ok) {
                const data: {items: FeedItemPreview[]} = await response.json()
                return data.items
            }
            return null
        } catch {
            return null
        }
    },
    async removeQueueItem(feedItemGuid: string): Promise<FeedItemPreview[] | null> {
        try {
            const response = await fetchWithTimeout(`/api/queue/${encodeURIComponent(feedItemGuid)}`, {
                method: 'DELETE',
            })
            if (response.ok) {
                const data: {items: FeedItemPreview[]} = await response.json()
                return data.items
            }
            return null
        } catch {
            return null
        }
    },
    async refreshFeed(feedGuid: string) {
        try {
            const response = await fetchWithTimeout(`/api/command/refresh-feed/${encodeURIComponent(feedGuid)}`, {
                method: 'POST',
            })
            return response.ok
        } catch {
            return false
        }
    },
    async searchFeedItems(query: string, options: SearchOptions = {}): Promise<FeedItemPreview[] | null> {
        try {
            const { limit, offset = 0 } = options
            const queryParams = new URLSearchParams()
            queryParams.set('q', query)
            queryParams.set('offset', String(offset))
            limit && queryParams.set('limit', String(limit))

            const response = await fetchWithTimeout(`/api/search?${queryParams}`)
            if (response.ok) return await response.json()
            return null
        } catch {
            return null
        }
    },
    async planFeedArchives(feedGuid: string) {
        try {
            const response = await fetchWithTimeout(`/api/command/plan-feed-archives/${encodeURIComponent(feedGuid)}`, {
                method: 'POST',
            })
            return response.ok
        } catch {
            return false
        }
    },
    async getQueue(): Promise<FeedItemPreview[] | null> {
        try {
            const response = await fetchWithTimeout('/api/queue')
            if (response.ok) {
                const data: {items: FeedItemPreview[]} = await response.json()
                return data.items
            }
            return null
        } catch {
            return null
        }
    },
    async getNotifications(): Promise<NotificationsResponse | null> {
        try {
            const response = await fetchWithTimeout('/api/notification')
            if (response.ok) return await response.json() as NotificationsResponse
            return null
        } catch {
            return null
        }
    },
    async dismissNotification(id: number) {
        try {
            const response = await fetchWithTimeout(`/api/notification/${id}`, {method: 'DELETE'})
            return response.ok
        } catch {
            return false
        }
    },
    async dismissAllNotifications() {
        try {
            const response = await fetchWithTimeout('/api/notification', {method: 'DELETE'})
            return response.ok
        } catch {
            return false
        }
    },
    async getVapidPublicKey(): Promise<string | null> {
        try {
            const response = await fetchWithTimeout('/api/push/vapid-public-key')
            if (response.ok) {
                const data = await response.json() as {key: string}
                return data.key || null
            }
            return null
        } catch {
            return null
        }
    },
    async registerPushSubscription(subscription: PushSubscriptionJSON) {
        try {
            const response = await fetchWithTimeout('/api/push/subscription', {
                method: 'POST',
                body: JSON.stringify(subscription),
            })
            return response.ok
        } catch {
            return false
        }
    },
    async unregisterPushSubscription(endpoint: string) {
        try {
            const response = await fetchWithTimeout('/api/push/subscription', {
                method: 'DELETE',
                body: JSON.stringify({endpoint}),
            })
            return response.ok
        } catch {
            return false
        }
    },
    async listTranscripts(itemGuid: string): Promise<Transcript[] | null> {
        try {
            const response = await fetchWithTimeout(`/api/feeditem/${encodeURIComponent(itemGuid)}/transcript`)
            if (response.ok) return await response.json() as Transcript[]
            return null
        } catch {
            return null
        }
    },
    async requestTranscript(itemGuid: string, opts: {model?: string, language?: string} = {}): Promise<Transcript | null> {
        try {
            const response = await fetchWithTimeout(`/api/feeditem/${encodeURIComponent(itemGuid)}/transcript`, {
                method: 'POST',
                body: JSON.stringify(opts),
            })
            if (response.ok) return await response.json() as Transcript
            return null
        } catch {
            return null
        }
    },
    async getTranscript(transcriptId: number): Promise<TranscriptFull | null> {
        try {
            const response = await fetchWithTimeout(`/api/transcript/${transcriptId}`)
            if (response.ok) return await response.json() as TranscriptFull
            return null
        } catch {
            return null
        }
    },
    async sendTestPushNotification(endpoint: string): Promise<{ok: true} | {ok: false, error: string}> {
        try {
            const response = await fetchWithTimeout('/api/push/test', {
                method: 'POST',
                body: JSON.stringify({endpoint}),
            })
            if (response.ok) return {ok: true}
            return {ok: false, error: response.statusText || `Server returned ${response.status}`}
        } catch (err) {
            return {ok: false, error: err instanceof Error ? err.message : 'Request failed'}
        }
    },
}
