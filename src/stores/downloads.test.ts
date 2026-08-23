import {IDBFactory} from 'fake-indexeddb'
import {createPinia, setActivePinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {makeItem} from '../testing/helpers.ts'
import {useDownloadStore} from './downloads.ts'

const AUDIO_BYTES = 1000

function audioItem() {
    return makeItem({
        enclosure_url: 'https://cdn.example.com/episode.mp3',
        enclosure_type: 'audio/mpeg',
    })
}

/** Stub the media proxy: apiFetch goes through the global fetch. */
function stubMediaFetch() {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(new Response(new Uint8Array(AUDIO_BYTES), {
            status: 200,
            headers: {'content-length': String(AUDIO_BYTES)},
        })))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

beforeEach(() => {
    // Fresh IndexedDB per test; jsdom lacks both indexedDB and object URLs.
    globalThis.indexedDB = new IDBFactory()
    let urls = 0
    URL.createObjectURL = vi.fn(() => `blob:mock-${++urls}`)
    URL.revokeObjectURL = vi.fn()
    setActivePinia(createPinia())
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    // Remove the own property the quota test defines over jsdom's navigator.
    Reflect.deleteProperty(navigator, 'storage')
})

describe('init', () => {
    it('starts empty on a fresh database', async () => {
        const store = useDownloadStore()
        await store.init()
        expect(store.totalStorageUsed).toBe(0)
        expect(store.getStatus('anything')).toBe('idle')
        expect(store.isDownloaded('anything')).toBe(false)
    })
})

describe('downloadItem', () => {
    it('streams the enclosure through the media proxy and records the download', async () => {
        const item = audioItem()
        const fetchMock = stubMediaFetch()
        const store = useDownloadStore()
        await store.init()

        await store.downloadItem(item)

        expect(fetchMock.mock.calls[0][0]).toBe(`/api/feeditem/${encodeURIComponent(item.guid)}/media`)
        expect(store.isDownloaded(item.guid)).toBe(true)
        expect(store.getStatus(item.guid)).toMatchObject({state: 'downloaded', size: AUDIO_BYTES})
        expect(store.totalStorageUsed).toBe(AUDIO_BYTES)
        expect(store.downloadedItems[item.guid]).toEqual(item)
        expect(store.blobUrls[item.guid]).toMatch(/^blob:mock-/)
    })

    it('persists the download so a later session sees it', async () => {
        const item = audioItem()
        stubMediaFetch()
        const store = useDownloadStore()
        await store.init()
        await store.downloadItem(item)

        // Simulate a new page load: fresh Pinia over the same IndexedDB.
        setActivePinia(createPinia())
        const nextSession = useDownloadStore()
        await nextSession.init()
        expect(nextSession.isDownloaded(item.guid)).toBe(true)
        expect(nextSession.totalStorageUsed).toBe(AUDIO_BYTES)
        expect(nextSession.downloadedItems[item.guid]).toEqual(item)
    })

    it('records an error status when the proxy responds with an error', async () => {
        const item = audioItem()
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, {status: 502}))))
        const store = useDownloadStore()
        await store.init()

        await store.downloadItem(item)
        expect(store.getStatus(item.guid)).toEqual({state: 'error', message: 'HTTP 502'})
        expect(store.totalStorageUsed).toBe(0)
    })

    it('refuses to download when storage is nearly full', async () => {
        const item = audioItem()
        stubMediaFetch()
        Object.defineProperty(navigator, 'storage', {
            configurable: true,
            value: {estimate: () => Promise.resolve({quota: 100 * 1024 * 1024, usage: 60 * 1024 * 1024})},
        })
        const store = useDownloadStore()
        await store.init()

        await store.downloadItem(item)
        expect(store.getStatus(item.guid)).toEqual({state: 'error', message: 'Insufficient storage space'})
    })

    it('returns to idle when the download is cancelled', async () => {
        const item = audioItem()
        vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener('abort', () =>
                    reject(new DOMException('The user aborted a request.', 'AbortError')))
            })))
        const store = useDownloadStore()
        await store.init()

        const downloading = store.downloadItem(item)
        expect(store.getStatus(item.guid)).toMatchObject({state: 'downloading', progress: 0})
        store.cancelDownload(item.guid)
        await downloading
        expect(store.getStatus(item.guid)).toBe('idle')
    })

    it('ignores items without an enclosure', async () => {
        const fetchMock = stubMediaFetch()
        const store = useDownloadStore()
        await store.init()
        await store.downloadItem(makeItem())
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe('getLocalUrl', () => {
    it('recreates a blob URL from the stored record in a fresh session', async () => {
        const item = audioItem()
        stubMediaFetch()
        const store = useDownloadStore()
        await store.init()
        await store.downloadItem(item)

        setActivePinia(createPinia())
        const nextSession = useDownloadStore()
        await nextSession.init()
        expect(nextSession.blobUrls[item.guid]).toBeUndefined()
        const url = await nextSession.getLocalUrl(item.guid)
        expect(url).toMatch(/^blob:mock-/)
        expect(nextSession.blobUrls[item.guid]).toBe(url)
    })

    it('returns null for an item that was never downloaded', async () => {
        const store = useDownloadStore()
        await store.init()
        expect(await store.getLocalUrl('missing')).toBeNull()
    })
})

describe('deleteDownload', () => {
    it('removes the record, revokes the blob URL and frees the accounting', async () => {
        const item = audioItem()
        stubMediaFetch()
        const store = useDownloadStore()
        await store.init()
        await store.downloadItem(item)
        const url = store.blobUrls[item.guid]

        await store.deleteDownload(item.guid)
        expect(store.getStatus(item.guid)).toBe('idle')
        expect(store.totalStorageUsed).toBe(0)
        expect(store.downloadedItems[item.guid]).toBeUndefined()
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)

        setActivePinia(createPinia())
        const nextSession = useDownloadStore()
        await nextSession.init()
        expect(nextSession.isDownloaded(item.guid)).toBe(false)
    })
})

describe('scheduleDelete', () => {
    it('deletes the download after the delay', async () => {
        const item = audioItem()
        stubMediaFetch()
        const store = useDownloadStore()
        await store.init()
        await store.downloadItem(item)

        vi.useFakeTimers({toFake: ['setTimeout']})
        await store.scheduleDelete(item.guid, 60_000)
        expect(store.isDownloaded(item.guid)).toBe(true)

        vi.advanceTimersByTime(60_000)
        vi.useRealTimers()
        await vi.waitFor(() => expect(store.getStatus(item.guid)).toBe('idle'))
    })

    it('an overdue scheduled deletion is applied on the next init', async () => {
        const item = audioItem()
        stubMediaFetch()
        const store = useDownloadStore()
        await store.init()
        await store.downloadItem(item)

        // Schedule with the timer suppressed, as if the page closed before it fired.
        vi.useFakeTimers({toFake: ['setTimeout']})
        await store.scheduleDelete(item.guid, 1)
        vi.useRealTimers()
        await new Promise(resolve => setTimeout(resolve, 5))

        setActivePinia(createPinia())
        const nextSession = useDownloadStore()
        await nextSession.init()
        await vi.waitFor(() => expect(nextSession.getStatus(item.guid)).toBe('idle'))
    })
})
