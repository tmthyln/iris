import {defineStore} from "pinia";
import {type FeedItemPreview, type LoadingState} from "../types.ts";
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
        return raw ? JSON.parse(raw) as FeedItemPreview[] : []
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
            void downloadStore.downloadItem(item)
        }
    }
}

export const useQueueStore = defineStore('queue', {
    state() {
        return {
            items: [] as FeedItemPreview[],
            paused: true,
            loadState: 'unloaded' as LoadingState,
            // Seek position (seconds) requested from outside the player
            // (e.g. transcript timestamps); AudioPlayer applies and clears it.
            pendingSeek: null as number | null,
        }
    },
    getters: {
        currentlyPlaying: (state) => state.items[0] ?? null,
    },
    actions: {
        async loadQueue() {
            if (this.loadState === 'loading') return
            this.loadState = 'loading'

            // Hydrate from localStorage immediately so the player can render
            // (in a loading state) while we await the network round-trip.
            if (this.items.length === 0) {
                const saved = loadQueueFromStorage()
                if (saved.length) {
                    this.items = saved
                    ensureDownloaded(saved)
                }
            }

            const result = await client.getQueue()
            const items = result.ok ? result.data : null
            if (items) {
                this.items = items
                saveQueueToStorage(items)
                ensureDownloaded(items)
                this.loadState = 'loaded'
            } else {
                // The localStorage copy (if any) stays visible; the state
                // records the failure so a resume can retry.
                this.loadState = 'error'
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

            const result = await client.queueFeedItem(item.guid, position)
            const serverItems = result.ok ? result.data : null
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

            const result = await client.removeQueueItem(item.guid)
            const serverItems = result.ok ? result.data : null
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

            const result = await client.clearQueue(keepFirst)
            const serverItems = result.ok ? result.data : null
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

            const result = await client.moveQueueItem(item.guid, position)
            const serverItems = result.ok ? result.data : null
            if (serverItems) {
                this.items = serverItems
                saveQueueToStorage(serverItems)
            }
            return true
        },
        togglePaused() {
            this.paused = !this.paused
        },
        requestSeek(seconds: number) {
            this.pendingSeek = seconds
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
