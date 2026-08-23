import {defineStore} from "pinia";
import type {AdjacentFeedItems, FeedItem, FeedItemPreview, LoadingState} from "../types.ts";
import client from '../client'
import {prefetchImagesFromHtml} from "../htmlproc.ts";

export const useFeedItemStore = defineStore('feeditems', {
    state: () => ({
        cache: {} as Record<string, FeedItemPreview>,
        fullCache: {} as Record<string, FeedItem>,
        adjacentCache: {} as Record<string, AdjacentFeedItems>,
        inflightFull: {} as Record<string, Promise<FeedItem | null> | undefined>,
        inflightAdjacent: {} as Record<string, Promise<AdjacentFeedItems | null> | undefined>,

        bookmarked: [] as string[],
        bookmarkedLoadState: 'unloaded' as LoadingState,

        recent: [] as string[],
        recentLoadState: 'unloaded' as LoadingState,
        recentHasMore: true,
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
        async loadFullItem(guid: string): Promise<FeedItem | null> {
            if (this.fullCache[guid]) return this.fullCache[guid]
            const inflight = this.inflightFull[guid]
            if (inflight) return inflight

            const promise = (async () => {
                const result = await client.getFeedItem(guid)
                const data = result.ok ? result.data : null
                if (data) this.fullCache[guid] = data
                delete this.inflightFull[guid]
                return data
            })()
            this.inflightFull[guid] = promise
            return promise
        },
        async loadAdjacent(guid: string): Promise<AdjacentFeedItems | null> {
            if (this.adjacentCache[guid]) return this.adjacentCache[guid]
            const inflight = this.inflightAdjacent[guid]
            if (inflight) return inflight

            const promise = (async () => {
                const result = await client.getAdjacentFeedItems(guid)
                const data = result.ok ? result.data : null
                if (data) this.adjacentCache[guid] = data
                delete this.inflightAdjacent[guid]
                return data
            })()
            this.inflightAdjacent[guid] = promise
            return promise
        },
        prefetchItem(guid: string) {
            // Fire-and-forget: warms the in-memory store, then the browser HTTP cache for any embedded images.
            void this.loadFullItem(guid).then(item => {
                if (item) prefetchImagesFromHtml(item.encoded_content, item.description)
            })
            void this.loadAdjacent(guid)
        },
        async bookmarkItem(feedItem: FeedItemPreview) {
            const success = (await client.modifyFeedItem(feedItem.guid, {bookmarked: true})).ok
            if (success) {
                const cachedFeedItem = this.cache[feedItem.guid]
                if (cachedFeedItem) {
                    cachedFeedItem.bookmarked = true
                }
                const cachedFull = this.fullCache[feedItem.guid]
                if (cachedFull) {
                    cachedFull.bookmarked = true
                }

                const index = this.bookmarked.indexOf(feedItem.guid)
                if (index < 0) {
                    this.bookmarked.push(feedItem.guid)
                }

                feedItem.bookmarked = true;
            }
        },
        async unbookmarkItem(feedItem: FeedItemPreview) {
            const success = (await client.modifyFeedItem(feedItem.guid, {bookmarked: false})).ok
            if (success) {
                const cachedFeedItem = this.cache[feedItem.guid]
                if (cachedFeedItem) {
                    cachedFeedItem.bookmarked = false
                }
                const cachedFull = this.fullCache[feedItem.guid]
                if (cachedFull) {
                    cachedFull.bookmarked = false
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
            const success = (await client.modifyFeedItem(
                feedItem.guid,
                effectiveProgress ? {finished: true, progress: effectiveProgress} : {finished: true})).ok

            if (success) {
                const cachedFeedItem = this.cache[feedItem.guid]
                if (cachedFeedItem) {
                    cachedFeedItem.finished = true
                    if (effectiveProgress)
                        cachedFeedItem.progress = effectiveProgress
                }
                const cachedFull = this.fullCache[feedItem.guid]
                if (cachedFull) {
                    cachedFull.finished = true
                    if (effectiveProgress)
                        cachedFull.progress = effectiveProgress
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
            const success = (await client.modifyFeedItem(feedItem.guid, {finished: false})).ok
            if (success) {
                const cachedFeedItem = this.cache[feedItem.guid]
                if (cachedFeedItem) {
                    cachedFeedItem.finished = false
                }
                const cachedFull = this.fullCache[feedItem.guid]
                if (cachedFull) {
                    cachedFull.finished = false
                }

                feedItem.finished = false
            }
        },
        async updateItemProgress(feedItem: FeedItemPreview, progress: number) {
            const effectiveProgress = Math.min(1, progress)
            const finished = effectiveProgress >= 1 ? true : null

            const success = (await client.modifyFeedItem(
                feedItem.guid,
                finished ? {finished: true, progress: effectiveProgress} : {progress: effectiveProgress})).ok
            if (success) {
                const cachedFeedItem = this.cache[feedItem.guid]
                if (cachedFeedItem) {
                    cachedFeedItem.progress = effectiveProgress
                    if (finished)
                        cachedFeedItem.finished = true
                }
                const cachedFull = this.fullCache[feedItem.guid]
                if (cachedFull) {
                    cachedFull.progress = effectiveProgress
                    if (finished)
                        cachedFull.finished = true
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

            const result = await client.getFeedItems({bookmarked: true})
            const data = result.ok ? result.data : null
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

            const result = await client.getFeedItems({limit: 20})
            const data = result.ok ? result.data : null

            if (data) {
                this.recent.length = 0
                this.recent.push(...data
                    .map((item=> {
                        this.cache[item.guid] = item
                        return item.guid
                    }))
                )

                this.recentHasMore = data.length >= 20
                this.recentLoadState = 'loaded'
            } else {
                this.recentLoadState = 'unloaded'
            }
        },
        async loadMoreRecentItems() {
            if (this.recentLoadState !== 'loaded' || !this.recentHasMore) {
                return
            }

            this.recentLoadState = 'loading'

            const result = await client.getFeedItems({limit: 20, offset: this.recent.length})
            const data = result.ok ? result.data : null

            if (data) {
                this.recent.push(...data
                    .filter(item => !this.recent.includes(item.guid))
                    .map(item => {
                        this.cache[item.guid] = item
                        return item.guid
                    })
                )

                this.recentHasMore = data.length >= 20
                this.recentLoadState = 'loaded'
            } else {
                this.recentLoadState = 'loaded'
            }
        },
    },
})
