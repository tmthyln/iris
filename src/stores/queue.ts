import {defineStore} from "pinia";
import {FeedItemPreview} from "../types.ts";
import client from "../client.ts";

export const useQueueStore = defineStore('queue', {
    state() {
        return {
            items: [] as FeedItemPreview[],
            paused: true,
        }
    },
    getters: {
        currentlyPlaying: (state) => state.items[0] ?? null,
    },
    actions: {
        async loadQueue() {
            const items = await client.getQueue()
            if (items) {
                this.items = items
            }
        },
        itemPlaying(item: FeedItemPreview) {
            return this.currentlyPlaying?.guid === item.guid
        },
        itemQueued(item: FeedItemPreview) {
            return !this.itemPlaying(item) && this.items.some(i => i.guid === item.guid)
        },
        itemQueuedOrPlaying(item: FeedItemPreview) {
            return this.items.some(i => i.guid === item.guid)
        },
        async addItem(item: FeedItemPreview, position?: number) {
            const items = await client.queueFeedItem(item.guid, position)
            if (items) {
                this.items = items
            }
            return items !== null
        },
        async removeItem(item: FeedItemPreview) {
            const items = await client.removeQueueItem(item.guid)
            if (items) {
                this.items = items
            }
            return items !== null
        },
        async moveItem(item: FeedItemPreview, position: number) {
            const items = await client.moveQueueItem(item.guid, position)
            if (items) {
                this.items = items
            }
            return items !== null
        },
        togglePaused() {
            this.paused = !this.paused
        },
        async playItem(item: FeedItemPreview) {
            if (!this.itemQueued(item)) {
                await this.addItem(item, 0)
            } else if (this.items[0]?.guid !== item.guid) {
                await this.removeItem(item)
                await this.addItem(item, 0)
            }
            this.paused = false
        },
    },
})