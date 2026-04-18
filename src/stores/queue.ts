import {defineStore} from "pinia";
import {FeedItemPreview} from "../types.ts";
import client from "../client.ts";
import {useDownloadStore} from "./downloads.ts";

const STORAGE_KEY = 'iris-queue'

function saveQueueToStorage(items: FeedItemPreview[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    } catch {
        // Ignore storage errors
    }
}

function loadQueueFromStorage(): FeedItemPreview[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        return raw ? JSON.parse(raw) : []
    } catch {
        return []
    }
}

function ensureDownloaded(items: FeedItemPreview[]) {
    const downloadStore = useDownloadStore()
    for (const item of items) {
        if (!item.enclosure_url) continue
        const status = downloadStore.getStatus(item.guid)
        if (status === 'idle' || (typeof status === 'object' && status.state === 'error')) {
            downloadStore.downloadItem(item)
        }
    }
}

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
                saveQueueToStorage(items)
                ensureDownloaded(items)
            } else {
                const saved = loadQueueFromStorage()
                if (saved.length) {
                    this.items = saved
                    ensureDownloaded(saved)
                }
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
            const optimistic = position !== undefined
                ? [...this.items.slice(0, position), item, ...this.items.slice(position)]
                : [...this.items, item]
            this.items = optimistic
            saveQueueToStorage(optimistic)
            ensureDownloaded([item])

            const serverItems = await client.queueFeedItem(item.guid, position)
            if (serverItems) {
                this.items = serverItems
                saveQueueToStorage(serverItems)
            }
            return true
        },
        async removeItem(item: FeedItemPreview) {
            const optimistic = this.items.filter(i => i.guid !== item.guid)
            this.items = optimistic
            saveQueueToStorage(optimistic)

            const serverItems = await client.removeQueueItem(item.guid)
            if (serverItems) {
                this.items = serverItems
                saveQueueToStorage(serverItems)
            }
            return true
        },
        async clearQueue(keepFirst: boolean) {
            const optimistic = keepFirst ? this.items.slice(0, 1) : []
            this.items = optimistic
            saveQueueToStorage(optimistic)

            const serverItems = await client.clearQueue(keepFirst)
            if (serverItems) {
                this.items = serverItems
                saveQueueToStorage(serverItems)
            }
            return true
        },
        async moveItem(item: FeedItemPreview, position: number) {
            const without = this.items.filter(i => i.guid !== item.guid)
            without.splice(position, 0, item)
            this.items = without
            saveQueueToStorage(without)

            const serverItems = await client.moveQueueItem(item.guid, position)
            if (serverItems) {
                this.items = serverItems
                saveQueueToStorage(serverItems)
            }
            return true
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
