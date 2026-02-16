import {FeedItem, FeedItemPreview} from "./types.ts";

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

export default {
    async getFeedItem(itemGuid: string) {
        const itemDataUrl = `/api/feeditem/${encodeURIComponent(itemGuid)}`
        const itemResponse = await fetch(itemDataUrl)
        if (itemResponse.ok) {
            const data: FeedItem = await itemResponse.json()

            return data
        }

        return null
    },
    async getFeedItems(options: GetFeedItemsOptions = {}) {
        const {
            bookmarked = null,
            limit = null,
            offset = 0,
        } = options

        const queryParams = new URLSearchParams()
        queryParams.set('offset', String(offset))
        limit && queryParams.set('limit', String(limit))
        bookmarked !== null && queryParams.set('bookmarked', String(bookmarked))

        const response = await fetch(`/api/feeditem?${queryParams}`)
        if (response.ok) {
            const data: FeedItemPreview[] = await response.json()
            return data
        }

        return null
    },
    async modifyFeed(feedGuid: string, updateData: { categories?: string[] }) {
        const response = await fetch(`/api/feed/${encodeURIComponent(feedGuid)}`, {
            method: 'PATCH',
            body: JSON.stringify(updateData),
        })

        return response.ok
    },
    async modifyFeedItem(itemGuid: string, updateData: FeedItemUpdateData) {
        const response = await fetch(`/api/feeditem/${encodeURIComponent(itemGuid)}`, {
            method: 'PATCH',
            body: JSON.stringify(updateData),
        })

        return response.ok
    },
    async queueFeedItem(feedItemGuid: string, position?: number): Promise<FeedItemPreview[] | null> {
        const response = await fetch('/api/queue', {
            method: 'POST',
            body: JSON.stringify({feedItemId: feedItemGuid, position}),
        })

        if (response.ok) {
            const data: {items: FeedItemPreview[]} = await response.json()
            return data.items
        }
        return null
    },
    async moveQueueItem(feedItemGuid: string, position: number): Promise<FeedItemPreview[] | null> {
        const response = await fetch(`/api/queue/${encodeURIComponent(feedItemGuid)}`, {
            method: 'PATCH',
            body: JSON.stringify({position}),
        })

        if (response.ok) {
            const data: {items: FeedItemPreview[]} = await response.json()
            return data.items
        }
        return null
    },
    async clearQueue(keepFirst: boolean): Promise<FeedItemPreview[] | null> {
        const params = keepFirst ? '?keepFirst=true' : ''
        const response = await fetch(`/api/queue${params}`, {
            method: 'DELETE',
        })

        if (response.ok) {
            const data: {items: FeedItemPreview[]} = await response.json()
            return data.items
        }
        return null
    },
    async removeQueueItem(feedItemGuid: string): Promise<FeedItemPreview[] | null> {
        const response = await fetch(`/api/queue/${encodeURIComponent(feedItemGuid)}`, {
            method: 'DELETE',
        })

        if (response.ok) {
            const data: {items: FeedItemPreview[]} = await response.json()
            return data.items
        }
        return null
    },
    async refreshFeed(feedGuid: string) {
        const response = await fetch(`/api/command/refresh-feed/${encodeURIComponent(feedGuid)}`, {
            method: 'POST',
        })
        return response.ok
    },
    async planFeedArchives(feedGuid: string) {
        const response = await fetch(`/api/command/plan-feed-archives/${encodeURIComponent(feedGuid)}`, {
            method: 'POST',
        })
        return response.ok
    },
    async getQueue(): Promise<FeedItemPreview[] | null> {
        const response = await fetch('/api/queue')
        if (response.ok) {
            const data: {items: FeedItemPreview[]} = await response.json()
            return data.items
        }
        return null
    },
}
