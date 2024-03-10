import {defineStore} from "pinia";
import type {Feed} from "../types.ts";

interface FeedStoreState {
    feeds: Feed[]
}

export const useFeedStore = defineStore('feeds', {
    state(): FeedStoreState {
        return {
            feeds: [],
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
            const response = await fetch('/api/feed')
            if (response.ok) {
                const data = await response.json();

                this.feeds.length = 0;
                this.feeds.push(...data);
            }
        },
        getFeedById(guid: string) {
            return this.feeds.find(feed => feed.guid === guid) ?? null;
        }
    },
})
