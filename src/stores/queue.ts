import {defineStore} from "pinia";
import {type FeedItemPreview, type LoadingState} from "../types.ts";
import client, {unanswered} from "../client.ts";
import {useDownloadStore} from "./downloads.ts";
import {useFeedItemStore} from "./feeditems.ts";

const STORAGE_KEY = 'iris-queue'
// Queue changes made while the API was unreachable, oldest first, replayed in
// order once it answers again (see syncPending).
const PENDING_KEY = 'iris-queue-pending'

type QueueChange =
    | {op: 'add', guid: string, position?: number}
    | {op: 'remove', guid: string}
    | {op: 'move', guid: string, position: number}
    | {op: 'clear', keepFirst: boolean}

function loadPendingChanges(): QueueChange[] {
    try {
        const raw = localStorage.getItem(PENDING_KEY)
        return raw ? JSON.parse(raw) as QueueChange[] : []
    } catch {
        return []
    }
}

function savePendingChanges(changes: QueueChange[]) {
    try {
        if (changes.length) localStorage.setItem(PENDING_KEY, JSON.stringify(changes))
        else localStorage.removeItem(PENDING_KEY)
    } catch {
        // Ignore storage errors
    }
}

function sendChange(change: QueueChange) {
    switch (change.op) {
        case 'add': return client.queueFeedItem(change.guid, change.position)
        case 'remove': return client.removeQueueItem(change.guid)
        case 'move': return client.moveQueueItem(change.guid, change.position)
        case 'clear': return client.clearQueue(change.keepFirst)
    }
}

let syncing: Promise<boolean> | null = null

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
            // Where to start an episode that is not loaded yet; AudioPlayer
            // applies and clears it once that episode's duration is known.
            pendingStart: null as {guid: string, seconds: number} | null,
            // Where the player is, for the transcript to follow.
            playbackPosition: 0,
        }
    },
    getters: {
        currentlyPlaying: (state) => state.items[0] ?? null,
        upcoming: (state) => state.items.slice(1),
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

            // The server's queue is stale until the changes made offline
            // reach it, and would otherwise replace them; likewise the
            // progress the items carry.
            await useFeedItemStore().flushPendingProgress()
            const synced = await this.syncPending()
            const result = synced ? await client.getQueue() : null
            const items = result?.ok ? result.data : null
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

            await this.applyChange({op: 'add', guid: item.guid, position})
            return true
        },
        async removeItem(item: FeedItemPreview) {
            const optimistic = this.items.filter(i => i.guid !== item.guid)
            this.items = optimistic
            saveQueueToStorage(optimistic)

            await this.applyChange({op: 'remove', guid: item.guid})
            return true
        },
        async clearQueue(keepFirst: boolean) {
            const optimistic = keepFirst ? this.items.slice(0, 1) : []
            this.items = optimistic
            saveQueueToStorage(optimistic)

            await this.applyChange({op: 'clear', keepFirst})
            return true
        },
        async moveItem(item: FeedItemPreview, position: number) {
            const without = this.items.filter(i => i.guid !== item.guid)
            without.splice(position, 0, item)
            this.items = without
            saveQueueToStorage(without)

            await this.applyChange({op: 'move', guid: item.guid, position})
            return true
        },
        /**
         * Send a change already made to the local queue. While earlier changes
         * are still waiting, it waits behind them, so the server applies them
         * in the order they were made.
         */
        async applyChange(change: QueueChange) {
            if (loadPendingChanges().length) {
                savePendingChanges([...loadPendingChanges(), change])
                await this.syncPending()
                return
            }
            const result = await sendChange(change)
            if (result.ok) {
                this.adoptServerItems(result.data)
            } else if (unanswered(result)) {
                savePendingChanges([change])
            }
        },
        /**
         * Replay the changes made while the API was unreachable. Resolves to
         * whether none are left.
         */
        syncPending(): Promise<boolean> {
            syncing ??= this.replayPendingChanges().finally(() => { syncing = null })
            return syncing
        },
        /** One replay at a time: through syncPending. */
        async replayPendingChanges(): Promise<boolean> {
            let latest: FeedItemPreview[] | null = null
            for (let change = loadPendingChanges()[0]; change; change = loadPendingChanges()[0]) {
                const result = await sendChange(change)
                if (unanswered(result)) return false
                // A rejected change (the item is gone) is dropped, not retried.
                savePendingChanges(loadPendingChanges().slice(1))
                if (result.ok) latest = result.data
            }
            if (latest) this.adoptServerItems(latest)
            return true
        },
        hasPendingChanges() {
            return loadPendingChanges().length > 0
        },
        adoptServerItems(items: FeedItemPreview[]) {
            this.items = items
            saveQueueToStorage(items)
        },
        /** Save the queue as it is now, e.g. after an item's progress changed in place. */
        persist() {
            saveQueueToStorage(this.items)
        },
        markAudioPinned(guid: string) {
            const item = this.items.find(i => i.guid === guid)
            if (!item) return
            item.pinned_audio = true
            saveQueueToStorage(this.items)
        },
        togglePaused() {
            this.paused = !this.paused
        },
        requestSeek(seconds: number) {
            this.pendingSeek = seconds
        },
        async playItemFrom(item: FeedItemPreview, seconds: number) {
            if (this.itemPlaying(item)) {
                this.requestSeek(seconds)
                return
            }
            this.pendingStart = {guid: item.guid, seconds}
            await this.playItem(item)
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
