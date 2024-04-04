import {defineStore} from "pinia";
import type {FeedItemPreview, LoadingState} from "../types.ts";

export const useFeedItemStore = defineStore('feeditems', {
    state() {
        return {
            cache: {} as {[index: string]: FeedItemPreview},
            bookmarked: [] as FeedItemPreview[],
            bookmarkedLoadState: 'unloaded' as LoadingState,

            recent: [] as FeedItemPreview[],
            recentLoadState: 'unloaded' as LoadingState,
        }
    },
    actions: {
        async bookmarkItem(feedItem: FeedItemPreview) {
            // TODO actually implement
            const index = this.bookmarked.findIndex(item => item.guid === feedItem.guid)
            if (index < 0) {
                this.bookmarked.push(feedItem)
            }
            feedItem.bookmarked = true;
        },
        async unbookmarkItem(feedItem: FeedItemPreview) {
            // TODO actually implement
            const index = this.bookmarked.findIndex(item => item.guid === feedItem.guid)
            if (index >= 0) {
                this.bookmarked.splice(index, 1)
            }
            feedItem.bookmarked = false;
        },
        async markItemAsComplete(feedItem: FeedItemPreview) {
            // TODO actually implement
            const index = this.recent.findIndex(item => item.guid === feedItem.guid)
            if (index >= 0) {
                this.recent.splice(index, 1)
            }
            feedItem.finished = true;
        },
        async markItemAsIncomplete(feedItem: FeedItemPreview) {
            // TODO actually implement
            feedItem.finished = false;
        },
        async updateItemProgress(feedItem: FeedItemPreview, progress: number) {
            feedItem.progress = Math.min(1, progress)
            if (feedItem.progress > 1) {
                feedItem.finished = true;
            }
            // TODO actually implement
        },
        async loadBookmarkedItems() {
            this.bookmarkedLoadState = 'loading'

            const response = await fetch('/api/feeditem?bookmarked=true')
            if (response.ok) {
                const data: FeedItemPreview[] = await response.json()
                this.bookmarked.length = 0
                this.bookmarked.push(...data
                    .map(item => {
                        this.cache[item.guid] = item
                        return item
                    })
                )

                this.bookmarkedLoadState = 'loaded'
            } else {
                this.bookmarkedLoadState = 'unloaded'
            }
        },
        async loadRecentUnreadItems() {
            this.recentLoadState = 'loading'

            const response = await fetch('/api/feeditem?limit=20')
            if (response.ok) {
                const data: FeedItemPreview[] = await response.json()
                this.recent.length = 0
                this.recent.push(...data
                    .map(item => {
                        this.cache[item.guid] = item
                        return item
                    })
                )

                this.recentLoadState = 'loaded'
            } else {
                this.recentLoadState = 'unloaded'
            }
        },
    },
})
