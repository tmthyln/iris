import {defineStore} from "pinia";
import type {Feed, LoadingState} from "../types.ts";
import client from "../client.ts";

type FeedLoadedCallback = () => unknown

export const useFeedStore = defineStore('feeds', {
    state: () => ({
        feeds: [] as Feed[],
        feedsLoadState: 'unloaded' as LoadingState,
        feedLoadedCallbacks: [] as FeedLoadedCallback[],
    }),
    getters: {
        allCategories: (state) => [...new Set(state.feeds.flatMap(feed => feed.categories))].sort(),
        feedsByCategory: (state) => {
            const map: {[category: string]: Feed[]} = {'Uncategorized': []}
            for (const feed of state.feeds) {
                if (feed.categories.length === 0) {
                    map['Uncategorized'].push(feed)
                } else {
                    feed.categories.forEach(category => {
                        if (Object.prototype.hasOwnProperty.call(map, category)) {
                            map[category].push(feed)
                        } else {
                            map[category] = [feed]
                        }
                    })
                }
            }
            if (map['Uncategorized'].length === 0) {
                delete map['Uncategorized']
            }
            return map
        },
    },
    actions: {
        async loadFeeds() {
            if (this.feedsLoadState === 'loading')
                return

            this.feedsLoadState = 'loading'

            const response = await fetch('/api/feed')
            if (response.ok) {
                const data = await response.json();

                this.feeds.length = 0;
                this.feeds.push(...(data as Feed[]));

                this.feedsLoadState = 'loaded'

                this.feedLoadedCallbacks.forEach(callback => callback())
                this.feedLoadedCallbacks.length = 0;
            } else {
                this.feedsLoadState = 'unloaded'
            }
        },
        async afterFeedsLoaded(func: FeedLoadedCallback) {
            if (this.feedsLoadState === 'loaded') {
                func()
            } else if (this.feedsLoadState === 'loading') {
                this.feedLoadedCallbacks.push(func)
            } else {
                await this.loadFeeds()
                func()
            }
        },
        getFeedById(guid: string) {
            return this.feeds.find(feed => feed.guid === guid) ?? null;
        },
        async refreshFeed(guid: string) {
            await client.refreshFeed(guid)
        },
        async planFeedArchives(guid: string) {
            await client.planFeedArchives(guid)
            const feed = this.feeds.find(f => f.guid === guid)
            if (feed) {
                feed.has_archives = true
            }
        },
        async updateFeedAlias(guid: string, alias: string) {
            const success = await client.modifyFeed(guid, {alias})
            if (success) {
                const feed = this.feeds.find(f => f.guid === guid)
                if (feed) {
                    feed.alias = alias
                }
            }
            return success
        },
        async updateFeedCategories(guid: string, categories: string[]) {
            const success = await client.modifyFeed(guid, {categories})
            if (success) {
                const feed = this.feeds.find(f => f.guid === guid)
                if (feed) {
                    feed.categories = categories
                }
            }
            return success
        },
    },
})
