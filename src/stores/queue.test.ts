import {createPinia, setActivePinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {err, makeItem, ok, stubClient, stubClientPending} from '../testing/helpers.ts'
import {useDownloadStore} from './downloads.ts'
import {useQueueStore} from './queue.ts'

const STORAGE_KEY = 'iris-queue'

beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
})
afterEach(() => vi.restoreAllMocks())

function storedQueue(): unknown {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
}

describe('loadQueue', () => {
    it('loads the queue from the server and persists it to localStorage', async () => {
        const items = [makeItem(), makeItem()]
        stubClient('getQueue', ok(items))
        const store = useQueueStore()

        await store.loadQueue()
        expect(store.items).toEqual(items)
        expect(store.loadState).toBe('loaded')
        expect(storedQueue()).toEqual(items)
    })

    it('hydrates from localStorage while the network round-trip is pending', async () => {
        const saved = [makeItem()]
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
        const {resolve} = stubClientPending('getQueue')
        const store = useQueueStore()

        const loading = store.loadQueue()
        expect(store.items).toEqual(saved)      // immediate hydration
        expect(store.loadState).toBe('loading')

        const serverItems = [makeItem(), makeItem()]
        resolve(ok(serverItems))
        await loading
        expect(store.items).toEqual(serverItems)
    })

    it('keeps the hydrated queue when the server is unreachable', async () => {
        const saved = [makeItem()]
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
        stubClient('getQueue', err(null, 'Network unavailable'))
        const store = useQueueStore()

        await store.loadQueue()
        expect(store.items).toEqual(saved)
        expect(store.loadState).toBe('error')
    })

    it('starts downloading queued audio that is not downloaded yet', async () => {
        const audio = makeItem({enclosure_url: 'https://example.com/a.mp3'})
        const article = makeItem()
        stubClient('getQueue', ok([audio, article]))
        const store = useQueueStore()
        const downloadStore = useDownloadStore()
        const download = vi.spyOn(downloadStore, 'downloadItem').mockResolvedValue()

        await store.loadQueue()
        expect(download).toHaveBeenCalledExactlyOnceWith(audio)
    })

    it('does not start a second request while loading', async () => {
        const {spy, resolve} = stubClientPending('getQueue')
        const store = useQueueStore()
        const first = store.loadQueue()
        const second = store.loadQueue()
        resolve(ok([]))
        await Promise.all([first, second])
        expect(spy).toHaveBeenCalledOnce()
    })
})

describe('membership getters', () => {
    it('distinguishes playing (head) from queued (rest)', () => {
        const store = useQueueStore()
        const [head, tail, absent] = [makeItem(), makeItem(), makeItem()]
        store.items = [head, tail]

        expect(store.currentlyPlaying).toEqual(head)
        expect(store.itemPlaying(head)).toBe(true)
        expect(store.itemQueued(head)).toBe(false)
        expect(store.itemQueued(tail)).toBe(true)
        expect(store.itemQueuedOrPlaying(head)).toBe(true)
        expect(store.itemQueuedOrPlaying(tail)).toBe(true)
        expect(store.itemQueuedOrPlaying(absent)).toBe(false)
    })
})

describe('queue mutations', () => {
    it('addItem appends optimistically, then adopts the server order', async () => {
        const existing = makeItem()
        const added = makeItem()
        const serverOrder = [existing, added]
        const {resolve} = stubClientPending('queueFeedItem')
        const store = useQueueStore()
        store.items = [existing]

        const call = store.addItem(added)
        expect(store.items).toEqual([existing, added])   // optimistic
        resolve(ok(serverOrder))
        await call
        expect(store.items).toEqual(serverOrder)
        expect(storedQueue()).toEqual(serverOrder)
        expect(vi.mocked(client.queueFeedItem)).toHaveBeenCalledExactlyOnceWith(added.guid, undefined)
    })

    it('addItem inserts at an explicit position', async () => {
        const [a, b, inserted] = [makeItem(), makeItem(), makeItem()]
        stubClient('queueFeedItem', ok([a, inserted, b]))
        const store = useQueueStore()
        store.items = [a, b]

        const call = store.addItem(inserted, 1)
        expect(store.items).toEqual([a, inserted, b])
        await call
        expect(vi.mocked(client.queueFeedItem)).toHaveBeenCalledExactlyOnceWith(inserted.guid, 1)
    })

    it('keeps the optimistic list when the server call fails', async () => {
        const added = makeItem()
        stubClient('queueFeedItem', err())
        const store = useQueueStore()

        await store.addItem(added)
        expect(store.items).toEqual([added])
        expect(storedQueue()).toEqual([added])
    })

    it('removeItem drops the item optimistically', async () => {
        const [a, b] = [makeItem(), makeItem()]
        stubClient('removeQueueItem', ok([b]))
        const store = useQueueStore()
        store.items = [a, b]

        const call = store.removeItem(a)
        expect(store.items).toEqual([b])
        await call
        expect(vi.mocked(client.removeQueueItem)).toHaveBeenCalledExactlyOnceWith(a.guid)
    })

    it('clearQueue can keep the currently playing item', async () => {
        const [head, tail] = [makeItem(), makeItem()]
        stubClient('clearQueue', ok([head]))
        const store = useQueueStore()
        store.items = [head, tail]

        const call = store.clearQueue(true)
        expect(store.items).toEqual([head])
        await call
        expect(vi.mocked(client.clearQueue)).toHaveBeenCalledExactlyOnceWith(true)
    })

    it('clearQueue can empty everything', async () => {
        stubClient('clearQueue', ok([]))
        const store = useQueueStore()
        store.items = [makeItem(), makeItem()]

        await store.clearQueue(false)
        expect(store.items).toEqual([])
        expect(storedQueue()).toEqual([])
    })

    it('moveItem reorders optimistically', async () => {
        const [a, b, c] = [makeItem(), makeItem(), makeItem()]
        stubClient('moveQueueItem', ok([b, c, a]))
        const store = useQueueStore()
        store.items = [a, b, c]

        const call = store.moveItem(a, 2)
        expect(store.items).toEqual([b, c, a])
        await call
        expect(vi.mocked(client.moveQueueItem)).toHaveBeenCalledExactlyOnceWith(a.guid, 2)
    })
})

describe('playback', () => {
    it('playItem puts a new item at the front and unpauses', async () => {
        const playing = makeItem()
        const fresh = makeItem()
        stubClient('queueFeedItem', ok([fresh, playing]))
        const store = useQueueStore()
        store.items = [playing]

        await store.playItem(fresh)
        expect(vi.mocked(client.queueFeedItem)).toHaveBeenCalledExactlyOnceWith(fresh.guid, 0)
        expect(store.items[0]).toEqual(fresh)
        expect(store.paused).toBe(false)
    })

    it('playItem moves an already-queued item to the front', async () => {
        const [head, queued] = [makeItem(), makeItem()]
        stubClient('removeQueueItem', ok([head]))
        stubClient('queueFeedItem', ok([queued, head]))
        const store = useQueueStore()
        store.items = [head, queued]

        await store.playItem(queued)
        expect(vi.mocked(client.removeQueueItem)).toHaveBeenCalledExactlyOnceWith(queued.guid)
        expect(vi.mocked(client.queueFeedItem)).toHaveBeenCalledExactlyOnceWith(queued.guid, 0)
        expect(store.items[0]).toEqual(queued)
        expect(store.paused).toBe(false)
    })

    it('togglePaused flips the flag', () => {
        const store = useQueueStore()
        expect(store.paused).toBe(true)
        store.togglePaused()
        expect(store.paused).toBe(false)
    })

    it('requestSeek records a pending seek for the player to apply', () => {
        const store = useQueueStore()
        store.requestSeek(125)
        expect(store.pendingSeek).toBe(125)
    })
})
