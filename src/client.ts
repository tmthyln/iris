import {AdjacentFeedItems, Feed, FeedItem, FeedItemPreview} from "./types.ts";

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
    async modifyFeed(feedGuid: string, updateData: { categories?: string[], alias?: string }) {
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
}
