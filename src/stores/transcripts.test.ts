import {createPinia, setActivePinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {err, makeFullTranscript, makeTranscript, ok, stubClient} from '../testing/helpers.ts'
import {useTranscriptStore} from './transcripts.ts'

const POLL_MS = 5000

beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
})
afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('refresh', () => {
    it('stores the transcript list for the item', async () => {
        const list = [makeTranscript({feed_item_guid: 'item-a'})]
        stubClient('listTranscripts', ok(list))
        const store = useTranscriptStore()

        expect(await store.refresh('item-a')).toEqual(list)
        expect(store.getForItem('item-a')).toEqual(list)
        expect(store.latest('item-a')).toEqual(list[0])
    })

    it('does not poll when nothing is in progress', async () => {
        stubClient('listTranscripts', ok([makeTranscript({status: 'complete'})]))
        const store = useTranscriptStore()
        await store.refresh('item-a')

        await vi.advanceTimersByTimeAsync(POLL_MS * 3)
        expect(vi.mocked(client.listTranscripts)).toHaveBeenCalledOnce()
    })

    it('polls an in-progress transcript until it settles, then stops', async () => {
        const pending = makeTranscript({status: 'pending'})
        const spy = stubClient('listTranscripts', ok([pending]))
        const store = useTranscriptStore()
        await store.refresh('item-a')

        // still in progress after one poll
        spy.mockResolvedValue(ok([{...pending, status: 'processing'}]))
        await vi.advanceTimersByTimeAsync(POLL_MS)
        expect(spy).toHaveBeenCalledTimes(2)
        expect(store.latest('item-a')?.status).toBe('processing')

        // completes on the next poll
        spy.mockResolvedValue(ok([{...pending, status: 'complete'}]))
        await vi.advanceTimersByTimeAsync(POLL_MS)
        expect(store.latest('item-a')?.status).toBe('complete')

        // poller has stopped
        await vi.advanceTimersByTimeAsync(POLL_MS * 3)
        expect(spy).toHaveBeenCalledTimes(3)
    })

    it('gives up polling after five consecutive failures', async () => {
        const spy = stubClient('listTranscripts', ok([makeTranscript({status: 'pending'})]))
        const store = useTranscriptStore()
        await store.refresh('item-a')

        spy.mockResolvedValue(err())
        await vi.advanceTimersByTimeAsync(POLL_MS * 10)
        // 1 refresh + 5 failed polls, then the poller unregisters itself
        expect(spy).toHaveBeenCalledTimes(6)
    })

    it('pauses polling while the document is hidden', async () => {
        let visibility: DocumentVisibilityState = 'visible'
        Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility})

        const spy = stubClient('listTranscripts', ok([makeTranscript({status: 'pending'})]))
        const store = useTranscriptStore()
        await store.refresh('item-a')

        visibility = 'hidden'
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(POLL_MS * 3)
        expect(spy).toHaveBeenCalledOnce()   // no polls while hidden

        visibility = 'visible'
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(POLL_MS)
        expect(spy).toHaveBeenCalledTimes(2)
    })

    it('tracks a loading flag per item', async () => {
        stubClient('listTranscripts', ok([]))
        const store = useTranscriptStore()
        const call = store.refresh('item-a')
        expect(store.loading['item-a']).toBe(true)
        await call
        expect(store.loading['item-a']).toBe(false)
    })
})

describe('request', () => {
    it('prepends the created transcript and starts polling', async () => {
        const existing = makeTranscript({status: 'error'})
        const created = makeTranscript({status: 'pending'})
        stubClient('requestTranscript', ok(created, 201))
        const listSpy = stubClient('listTranscripts', ok([created, existing]))
        const store = useTranscriptStore()
        store.byItem['item-a'] = [existing]

        expect(await store.request('item-a', {model: 'whisper'})).toEqual(created)
        expect(vi.mocked(client.requestTranscript)).toHaveBeenCalledExactlyOnceWith('item-a', {model: 'whisper'})
        expect(store.getForItem('item-a')).toEqual([created, existing])

        await vi.advanceTimersByTimeAsync(POLL_MS)
        expect(listSpy).toHaveBeenCalledOnce()   // polling started
    })

    it('replaces a known transcript instead of duplicating it (server dedupes)', async () => {
        const known = makeTranscript({status: 'pending'})
        stubClient('requestTranscript', ok(known, 201))
        stubClient('listTranscripts', ok([known]))
        const store = useTranscriptStore()
        store.byItem['item-a'] = [known]

        await store.request('item-a')
        expect(store.getForItem('item-a')).toEqual([known])
    })

    it('returns null and changes nothing when the request fails', async () => {
        stubClient('requestTranscript', err(429, 'Too many requests'))
        const store = useTranscriptStore()
        expect(await store.request('item-a')).toBeNull()
        expect(store.getForItem('item-a')).toEqual([])
    })
})

describe('loadFull', () => {
    it('fetches the full transcript once and caches it', async () => {
        const full = makeFullTranscript({text: 'Complete text'})
        stubClient('getTranscript', ok(full))
        const store = useTranscriptStore()

        expect(await store.loadFull(full.id)).toEqual(full)
        expect(await store.loadFull(full.id)).toEqual(full)
        expect(vi.mocked(client.getTranscript)).toHaveBeenCalledOnce()
    })

    it('returns null on failure without caching', async () => {
        stubClient('getTranscript', err(404, 'Not found'))
        const store = useTranscriptStore()
        expect(await store.loadFull(7)).toBeNull()
        expect(store.fullById[7]).toBeUndefined()
    })
})

describe('accessors', () => {
    it('getForItem and latest default to empty/null', () => {
        const store = useTranscriptStore()
        expect(store.getForItem('unknown')).toEqual([])
        expect(store.latest('unknown')).toBeNull()
    })
})
