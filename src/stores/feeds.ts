import {defineStore} from "pinia";
import type {Feed, LoadingState} from "../types.ts";
import client from "../client.ts";

type FeedLoadedCallback = () => unknown

export const useFeedStore = defineStore('feeds', {
    state: () => ({
        feeds: [] as Feed[],
        feedsLoadState: 'unloaded' as LoadingState,
        feedsLoadedAt: null as number | null,
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
            const collator = new Intl.Collator(undefined, {sensitivity: 'base', numeric: true})
            const displayName = (feed: Feed) => feed.alias || feed.title
            const sorted: {[category: string]: Feed[]} = {}
            const categoryNames = Object.keys(map)
                .filter(name => name !== 'Uncategorized')
                .sort((a, b) => collator.compare(a, b))
            if ('Uncategorized' in map) categoryNames.unshift('Uncategorized')
            for (const category of categoryNames) {
                sorted[category] = [...map[category]].sort((a, b) => collator.compare(displayName(a), displayName(b)))
            }
            return sorted
        },
    },
    actions: {
        async loadFeeds() {
            if (this.feedsLoadState === 'loading')
                return

            this.feedsLoadState = 'loading'

            const result = await client.getFeeds()
            const data = result.ok ? result.data : null
            if (data) {
                this.feeds.length = 0;
                this.feeds.push(...data);

                this.feedsLoadState = 'loaded'
                this.feedsLoadedAt = Date.now()

                this.feedLoadedCallbacks.forEach(callback => callback())
                this.feedLoadedCallbacks.length = 0;
            } else {
                // Keep any previously loaded feeds; only the state records the failure.
                this.feedsLoadState = 'error'
            }
        },
        /**
         * Reload the feed list when the last attempt failed or the data is
         * older than maxAgeMs — used when the (PWA) app is resumed from the
         * background or comes back online.
         */
        async refreshIfStale(maxAgeMs: number) {
            if (this.feedsLoadState === 'loading') return
            const fresh = this.feedsLoadState === 'loaded'
                && this.feedsLoadedAt !== null
                && Date.now() - this.feedsLoadedAt < maxAgeMs
            if (!fresh) await this.loadFeeds()
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
            const success = (await client.modifyFeed(guid, {alias})).ok
            if (success) {
                const feed = this.feeds.find(f => f.guid === guid)
                if (feed) {
                    feed.alias = alias
                }
            }
            return success
        },
        async updateFeedCategories(guid: string, categories: string[]) {
            const success = (await client.modifyFeed(guid, {categories})).ok
            if (success) {
                const feed = this.feeds.find(f => f.guid === guid)
                if (feed) {
                    feed.categories = categories
                }
            }
            return success
        },
        async setNotifyEnabled(guid: string, notify_enabled: boolean) {
            const feed = this.feeds.find(f => f.guid === guid)
            const previous = feed?.notify_enabled ?? false
            if (feed) feed.notify_enabled = notify_enabled
            const success = (await client.modifyFeed(guid, {notify_enabled})).ok
            if (!success && feed) {
                feed.notify_enabled = previous
            }
            return success
        },
    },
})
