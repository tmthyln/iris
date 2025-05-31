import {defineStore} from "pinia";
import type {Feed, LoadingState} from "../types.ts";

type FeedLoadedCallback = () => unknown

export const useFeedStore = defineStore('feeds', {
    state: () => ({
        feeds: [] as Feed[],
        feedsLoadState: 'unloaded' as LoadingState,
        feedLoadedCallbacks: [] as FeedLoadedCallback[],
    }),
    getters: {
        feedsByCategory: (state) => state.feeds.reduce((map, feed) => {
            feed.categories.forEach(category => {
                if (Object.prototype.hasOwnProperty.call(map, category)) {
                    map[category].push(feed)
                } else {
                    map[category] = [feed]
                }
            })

            if (feed.categories.length === 0) {
                if (Object.prototype.hasOwnProperty.call(map, 'Uncategorized')) {
                    map['Uncategorized'].push(feed)
                } else {
                    map['Uncategorized'] = [feed]
                }
            }

            return map
        }, {} as {[category: string]: Feed[]}),
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
                this.feeds.push(...data);

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
    },
})
