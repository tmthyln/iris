import {defineStore} from "pinia";
import type {FeedItemPreview, LoadingState} from "../types.ts";
import client from '../client'

export const useFeedItemStore = defineStore('feeditems', {
    state: () => ({
        cache: {} as Record<string, FeedItemPreview>,

        bookmarked: [] as string[],
        bookmarkedLoadState: 'unloaded' as LoadingState,

        recent: [] as string[],
        recentLoadState: 'unloaded' as LoadingState,
    }),
    getters: {
        bookmarkedItems: (state) =>
            state.bookmarked
                .map(guid => state.cache[guid])
                .filter(item => item !== null),
        recentItems: (state) =>
            state.recent
                .map(guid => state.cache[guid])
                .filter(item => item !== null),
    },
    actions: {
        async bookmarkItem(feedItem: FeedItemPreview) {
            const success = await client.modifyFeedItem(feedItem.guid, {bookmarked: true})
            if (success) {
                const cachedFeedItem = this.cache[feedItem.guid]
                if (cachedFeedItem) {
                    cachedFeedItem.bookmarked = true
                }

                const index = this.bookmarked.indexOf(feedItem.guid)
                if (index < 0) {
                    this.bookmarked.push(feedItem.guid)
                }

                feedItem.bookmarked = true;
            }
        },
        async unbookmarkItem(feedItem: FeedItemPreview) {
            const success = await client.modifyFeedItem(feedItem.guid, {bookmarked: false})
            if (success) {
                const cachedFeedItem = this.cache[feedItem.guid]
                if (cachedFeedItem) {
                    cachedFeedItem.bookmarked = false
                }

                const index = this.bookmarked.indexOf(feedItem.guid)
                if (index >= 0) {
                    this.bookmarked.splice(index, 1)
                }

                feedItem.bookmarked = false;
            }
        },
        async markItemAsComplete(feedItem: FeedItemPreview, progress: number | null = null) {
            const effectiveProgress = progress ? Math.min(1, progress) : null
            const success = await client.modifyFeedItem(
                feedItem.guid,
                effectiveProgress ? {finished: true, progress: effectiveProgress} : {finished: true})

            if (success) {
                const cachedFeedItem = this.cache[feedItem.guid]
                if (cachedFeedItem) {
                    cachedFeedItem.finished = true
                    if (effectiveProgress)
                        cachedFeedItem.progress = effectiveProgress
                }

                feedItem.finished = true
                if (effectiveProgress)
                    feedItem.progress = effectiveProgress

                const index = this.recent.indexOf(feedItem.guid)
                if (index >= 0) {
                    this.recent.splice(index, 1)
                }
            }
        },
        async markItemAsIncomplete(feedItem: FeedItemPreview) {
            const success = await client.modifyFeedItem(feedItem.guid, {finished: false})
            if (success) {
                const cachedFeedItem = this.cache[feedItem.guid]
                if (cachedFeedItem) {
                    cachedFeedItem.finished = false
                }

                feedItem.finished = false
            }
        },
        async updateItemProgress(feedItem: FeedItemPreview, progress: number) {
            const effectiveProgress = Math.min(1, progress)
            const finished = effectiveProgress >= 1 ? true : null

            const success = await client.modifyFeedItem(
                feedItem.guid,
                finished ? {finished: true, progress: effectiveProgress} : {progress: effectiveProgress})
            if (success) {
                const cachedFeedItem = this.cache[feedItem.guid]
                if (cachedFeedItem) {
                    cachedFeedItem.progress = effectiveProgress
                    if (finished)
                        cachedFeedItem.finished = true
                }

                if (finished) {
                    const index = this.recent.indexOf(feedItem.guid)
                    if (index >= 0) {
                        this.recent.splice(index, 1)
                    }
                }

                feedItem.progress = effectiveProgress
                if (finished)
                    feedItem.finished = true
            }
        },
        async loadBookmarkedItems() {
            if (this.bookmarkedLoadState !== 'unloaded') {
                return
            }

            this.bookmarkedLoadState = 'loading'

            const data = await client.getFeedItems({bookmarked: true})
            if (data) {
                this.bookmarked.length = 0
                this.bookmarked.push(...data
                    .map(item => {
                        this.cache[item.guid] = item
                        return item.guid
                    })
                )

                this.bookmarkedLoadState = 'loaded'
            } else {
                this.bookmarkedLoadState = 'unloaded'
            }
        },
        async loadRecentUnreadItems() {
            if (this.recentLoadState !== 'unloaded') {
                return
            }

            this.recentLoadState = 'loading'

            const data = await client.getFeedItems({limit: 20})

            if (data) {
                this.recent.length = 0
                this.recent.push(...data
                    .map((item=> {
                        this.cache[item.guid] = item
                        return item.guid
                    }))
                )

                this.recentLoadState = 'loaded'
            } else {
                this.recentLoadState = 'unloaded'
            }
        },
    },
})
