import {createPinia, setActivePinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {err, makeFullItem, makeItem, ok, stubClient, stubClientPending} from '../testing/helpers.ts'
import {useFeedItemStore} from './feeditems.ts'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.restoreAllMocks())

describe('loadFullItem', () => {
    it('fetches once and serves later calls from the cache', async () => {
        const item = makeFullItem()
        stubClient('getFeedItem', ok(item))
        const store = useFeedItemStore()

        expect(await store.loadFullItem(item.guid)).toEqual(item)
        expect(await store.loadFullItem(item.guid)).toEqual(item)
        expect(vi.mocked(client.getFeedItem)).toHaveBeenCalledOnce()
    })

    it('deduplicates concurrent requests for the same item', async () => {
        const item = makeFullItem()
        const {spy, resolve} = stubClientPending('getFeedItem')
        const store = useFeedItemStore()

        const first = store.loadFullItem(item.guid)
        const second = store.loadFullItem(item.guid)
        resolve(ok(item))
        expect(await first).toEqual(item)
        expect(await second).toEqual(item)
        expect(spy).toHaveBeenCalledOnce()
    })

    it('returns null on failure without caching, so a retry refetches', async () => {
        stubClient('getFeedItem', err())
        const store = useFeedItemStore()
        expect(await store.loadFullItem('g')).toBeNull()

        const item = makeFullItem({guid: 'g'})
        stubClient('getFeedItem', ok(item))
        expect(await store.loadFullItem('g')).toEqual(item)
    })
})

describe('loadAdjacent', () => {
    it('caches adjacent items per guid', async () => {
        const adjacent = {prev: makeItem(), next: null}
        stubClient('getAdjacentFeedItems', ok(adjacent))
        const store = useFeedItemStore()

        expect(await store.loadAdjacent('g')).toEqual(adjacent)
        expect(await store.loadAdjacent('g')).toEqual(adjacent)
        expect(vi.mocked(client.getAdjacentFeedItems)).toHaveBeenCalledOnce()
    })
})

describe('prefetchItem', () => {
    it('warms the full item and adjacent caches', async () => {
        const item = makeFullItem()
        stubClient('getFeedItem', ok(item))
        stubClient('getAdjacentFeedItems', ok({prev: null, next: null}))
        const store = useFeedItemStore()

        store.prefetchItem(item.guid)
        await vi.waitFor(() => {
            expect(store.fullCache[item.guid]).toBeDefined()
            expect(store.adjacentCache[item.guid]).toBeDefined()
        })
    })
})

describe('bookmarking', () => {
    it('bookmarkItem updates the item, both caches and the bookmarked list', async () => {
        stubClient('modifyFeedItem', ok(undefined))
        const store = useFeedItemStore()
        const item = makeItem()
        store.cache[item.guid] = {...item}
        store.fullCache[item.guid] = makeFullItem({...item})

        await store.bookmarkItem(item)
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {bookmarked: true})
        expect(item.bookmarked).toBe(true)
        expect(store.cache[item.guid].bookmarked).toBe(true)
        expect(store.fullCache[item.guid].bookmarked).toBe(true)
        expect(store.bookmarked).toContain(item.guid)

        // bookmarking again does not duplicate the entry
        await store.bookmarkItem(item)
        expect(store.bookmarked.filter(guid => guid === item.guid)).toHaveLength(1)
    })

    it('unbookmarkItem clears the flag and removes the guid from the list', async () => {
        stubClient('modifyFeedItem', ok(undefined))
        const store = useFeedItemStore()
        const item = makeItem({bookmarked: true})
        store.cache[item.guid] = {...item}
        store.bookmarked.push(item.guid)

        await store.unbookmarkItem(item)
        expect(item.bookmarked).toBe(false)
        expect(store.cache[item.guid].bookmarked).toBe(false)
        expect(store.bookmarked).not.toContain(item.guid)
    })

    it('changes nothing when the server rejects', async () => {
        stubClient('modifyFeedItem', err())
        const store = useFeedItemStore()
        const item = makeItem()

        await store.bookmarkItem(item)
        expect(item.bookmarked).toBe(false)
        expect(store.bookmarked).toEqual([])
    })
})

describe('completion', () => {
    it('markItemAsComplete finishes the item and drops it from the recent list', async () => {
        stubClient('modifyFeedItem', ok(undefined))
        const store = useFeedItemStore()
        const item = makeItem()
        store.cache[item.guid] = {...item}
        store.recent.push(item.guid)

        await store.markItemAsComplete(item)
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {finished: true})
        expect(item.finished).toBe(true)
        expect(store.cache[item.guid].finished).toBe(true)
        expect(store.recent).not.toContain(item.guid)
    })

    it('markItemAsComplete clamps an explicit progress to 1', async () => {
        stubClient('modifyFeedItem', ok(undefined))
        const store = useFeedItemStore()
        const item = makeItem()

        await store.markItemAsComplete(item, 1.7)
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {finished: true, progress: 1})
        expect(item.progress).toBe(1)
    })

    it('markItemAsIncomplete reverses the flag', async () => {
        stubClient('modifyFeedItem', ok(undefined))
        const store = useFeedItemStore()
        const item = makeItem({finished: true})
        store.cache[item.guid] = {...item}

        await store.markItemAsIncomplete(item)
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {finished: false})
        expect(item.finished).toBe(false)
        expect(store.cache[item.guid].finished).toBe(false)
    })
})

describe('updateItemProgress', () => {
    it('stores partial progress without finishing', async () => {
        stubClient('modifyFeedItem', ok(undefined))
        const store = useFeedItemStore()
        const item = makeItem()
        store.recent.push(item.guid)

        await store.updateItemProgress(item, 0.4)
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {progress: 0.4})
        expect(item.progress).toBe(0.4)
        expect(item.finished).toBe(false)
        expect(store.recent).toContain(item.guid)
    })

    it('finishes the item at progress >= 1 and drops it from recent', async () => {
        stubClient('modifyFeedItem', ok(undefined))
        const store = useFeedItemStore()
        const item = makeItem()
        store.cache[item.guid] = {...item}
        store.recent.push(item.guid)

        await store.updateItemProgress(item, 1.2)
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {finished: true, progress: 1})
        expect(item.finished).toBe(true)
        expect(item.progress).toBe(1)
        expect(store.recent).not.toContain(item.guid)
    })

    it('leaves everything untouched when the server rejects', async () => {
        stubClient('modifyFeedItem', err())
        const store = useFeedItemStore()
        const item = makeItem({progress: 0.2})
        await store.updateItemProgress(item, 0.5)
        expect(item.progress).toBe(0.2)
    })
})

describe('bookmarked list loading', () => {
    it('loads bookmarked previews into the cache', async () => {
        const items = [makeFullItem({bookmarked: true}), makeFullItem({bookmarked: true})]
        stubClient('getFeedItems', ok(items))
        const store = useFeedItemStore()

        await store.loadBookmarkedItems()
        expect(vi.mocked(client.getFeedItems)).toHaveBeenCalledExactlyOnceWith({bookmarked: true})
        expect(store.bookmarked).toEqual(items.map(i => i.guid))
        expect(store.bookmarkedItems).toEqual(items)
        expect(store.bookmarkedLoadState).toBe('loaded')
    })

    it('is a no-op once loaded', async () => {
        stubClient('getFeedItems', ok([]))
        const store = useFeedItemStore()
        await store.loadBookmarkedItems()
        await store.loadBookmarkedItems()
        expect(vi.mocked(client.getFeedItems)).toHaveBeenCalledOnce()
    })

    it('records a failure as the error state and can retry from it', async () => {
        stubClient('getFeedItems', err())
        const store = useFeedItemStore()
        await store.loadBookmarkedItems()
        expect(store.bookmarkedLoadState).toBe('error')

        const items = [makeFullItem({bookmarked: true})]
        stubClient('getFeedItems', ok(items))
        await store.loadBookmarkedItems()   // guard lets an errored load retry
        expect(store.bookmarkedLoadState).toBe('loaded')
        expect(store.bookmarkedItems).toEqual(items)
    })
})

describe('recent list loading', () => {
    it('loads the first page and tracks whether more may exist', async () => {
        const fullPage = Array.from({length: 20}, () => makeFullItem())
        stubClient('getFeedItems', ok(fullPage))
        const store = useFeedItemStore()

        await store.loadRecentUnreadItems()
        expect(vi.mocked(client.getFeedItems)).toHaveBeenCalledExactlyOnceWith({limit: 20})
        expect(store.recent).toHaveLength(20)
        expect(store.recentHasMore).toBe(true)
        expect(store.recentLoadState).toBe('loaded')
    })

    it('a short first page means no more items', async () => {
        stubClient('getFeedItems', ok([makeFullItem()]))
        const store = useFeedItemStore()
        await store.loadRecentUnreadItems()
        expect(store.recentHasMore).toBe(false)
    })

    it('loadMoreRecentItems appends the next page, skipping duplicates', async () => {
        const firstPage = Array.from({length: 20}, () => makeFullItem())
        stubClient('getFeedItems', ok(firstPage))
        const store = useFeedItemStore()
        await store.loadRecentUnreadItems()

        const nextPage = [firstPage[19], makeFullItem(), makeFullItem()]
        stubClient('getFeedItems', ok(nextPage))
        await store.loadMoreRecentItems()
        expect(vi.mocked(client.getFeedItems)).toHaveBeenLastCalledWith({limit: 20, offset: 20})
        expect(store.recent).toHaveLength(22)   // duplicate skipped
        expect(store.recentHasMore).toBe(false) // short page
    })

    it('loadMoreRecentItems is a no-op when there is nothing more', async () => {
        stubClient('getFeedItems', ok([makeFullItem()]))
        const store = useFeedItemStore()
        await store.loadRecentUnreadItems()

        await store.loadMoreRecentItems()
        expect(vi.mocked(client.getFeedItems)).toHaveBeenCalledOnce()
    })

    it('records a failed first page as the error state', async () => {
        stubClient('getFeedItems', err())
        const store = useFeedItemStore()
        await store.loadRecentUnreadItems()
        expect(store.recentLoadState).toBe('error')
    })

    it('reloadRecentItems replaces the list even when already loaded', async () => {
        const firstLoad = [makeFullItem()]
        stubClient('getFeedItems', ok(firstLoad))
        const store = useFeedItemStore()
        await store.loadRecentUnreadItems()

        const secondLoad = [makeFullItem(), makeFullItem()]
        stubClient('getFeedItems', ok(secondLoad))
        await store.reloadRecentItems()
        expect(store.recentItems).toEqual(secondLoad)
    })

    it('refreshRecentIfStale reloads only failed or stale data', async () => {
        stubClient('getFeedItems', ok([makeFullItem()]))
        const store = useFeedItemStore()
        await store.loadRecentUnreadItems()

        await store.refreshRecentIfStale(60_000)   // fresh
        expect(vi.mocked(client.getFeedItems)).toHaveBeenCalledOnce()

        await store.refreshRecentIfStale(0)        // stale
        expect(vi.mocked(client.getFeedItems)).toHaveBeenCalledTimes(2)
    })

    it('recentItems maps guids through the cache', async () => {
        const items = [makeFullItem(), makeFullItem()]
        stubClient('getFeedItems', ok(items))
        const store = useFeedItemStore()
        await store.loadRecentUnreadItems()
        expect(store.recentItems).toEqual(items)
    })
})
