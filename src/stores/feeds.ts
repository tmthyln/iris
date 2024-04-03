import {defineStore} from "pinia";
import type {Feed, LoadingState} from "../types.ts";

type FeedLoadedCallback = () => any

interface FeedStoreState {
    feeds: Feed[]
    feedsLoadState: LoadingState
    feedLoadedCallbacks: FeedLoadedCallback[]
}

export const useFeedStore = defineStore('feeds', {
    state(): FeedStoreState {
        return {
            feeds: [] as Feed[],
            feedsLoadState: 'unloaded',
            feedLoadedCallbacks: [] as FeedLoadedCallback[],
        }
    },
    getters: {
        feedsByCategory: (state: FeedStoreState) => state.feeds.reduce((map, feed) => {
            feed.categories.forEach(category => {
                if (map.hasOwnProperty(category)) {
                    map[category].push(feed)
                } else {
                    map[category] = [feed]
                }
            })

            if (feed.categories.length === 0) {
                if (map.hasOwnProperty('Uncategorized')) {
                    map['Uncategorized'].push(feed)
                } else {
                    map['Uncategorized'] = [feed]
                }
            }

            return map
        }, {}),
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
        async afterFeedsLoaded(func) {
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
