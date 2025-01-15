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
    async modifyFeedItem(itemGuid: string, updateData: FeedItemUpdateData) {
        const response = await fetch(`/api/feeditem/${encodeURIComponent(itemGuid)}`, {
            method: 'PATCH',
            body: JSON.stringify(updateData),
        })

        return response.ok
    },
}
