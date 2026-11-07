import {flushPromises, mount} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import client from '../client.ts'
import {useFeedItemStore} from '../stores/feeditems.ts'
import {useFeedStore} from '../stores/feeds.ts'
import {useQueueStore} from '../stores/queue.ts'
import {makeFeed, makeFullItem, makeItem, ok, stubClient} from '../testing/helpers.ts'
import {useResumeRefresh} from './useResumeRefresh.ts'

let visibility: DocumentVisibilityState = 'visible'
let harness: ReturnType<typeof mount> | null = null

beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility})
})
afterEach(() => {
    // Unmount so this test's listeners don't fire again in later tests.
    harness?.unmount()
    harness = null
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'onLine')
})

function mountResumeRefresh() {
    harness = mount(defineComponent({
        setup() {
            useResumeRefresh()
            return () => h('div')
        },
    }))
}

async function backgroundAndResume() {
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
}

async function goOffline() {
    Object.defineProperty(navigator, 'onLine', {configurable: true, value: false})
    window.dispatchEvent(new Event('offline'))
    await flushPromises()
}

async function backOnline() {
    Object.defineProperty(navigator, 'onLine', {configurable: true, value: true})
    window.dispatchEvent(new Event('online'))
    await flushPromises()
}

describe('on resume (hidden → visible)', () => {
    it('retries loads that failed, recovering the stuck empty states', async () => {
        // The PWA launched offline: every initial load failed.
        stubClient('getFeeds', {ok: false, status: null, error: 'Network unavailable'})
        stubClient('getFeedItems', {ok: false, status: null, error: 'Network unavailable'})
        stubClient('getQueue', {ok: false, status: null, error: 'Network unavailable'})
        const feedStore = useFeedStore()
        const feedItemStore = useFeedItemStore()
        const queueStore = useQueueStore()
        await feedStore.loadFeeds()
        await feedItemStore.loadRecentUnreadItems()
        await feedItemStore.loadBookmarkedItems()
        await queueStore.loadQueue()
        mountResumeRefresh()

        // Connectivity is back by the time the app is resumed.
        stubClient('getFeeds', ok([makeFeed()]))
        stubClient('getFeedItems', ok([makeFullItem()]))
        stubClient('getQueue', ok([makeItem()]))
        await backgroundAndResume()

        expect(feedStore.feedsLoadState).toBe('loaded')
        expect(feedStore.feeds).toHaveLength(1)
        expect(feedItemStore.recentLoadState).toBe('loaded')
        expect(feedItemStore.bookmarkedLoadState).toBe('loaded')
        expect(queueStore.loadState).toBe('loaded')
    })

    it('leaves fresh data and a healthy queue alone', async () => {
        stubClient('getFeeds', ok([makeFeed()]))
        stubClient('getFeedItems', ok([makeFullItem()]))
        stubClient('getQueue', ok([makeItem()]))
        const feedStore = useFeedStore()
        const feedItemStore = useFeedItemStore()
        const queueStore = useQueueStore()
        await feedStore.loadFeeds()
        await feedItemStore.loadRecentUnreadItems()
        await queueStore.loadQueue()
        mountResumeRefresh()

        await backgroundAndResume()
        expect(vi.mocked(client.getFeeds)).toHaveBeenCalledOnce()
        expect(vi.mocked(client.getFeedItems)).toHaveBeenCalledOnce()
        expect(vi.mocked(client.getQueue)).toHaveBeenCalledOnce()
    })

    it('refreshes data that has gone stale in the background', async () => {
        vi.useFakeTimers({toFake: ['Date']})
        stubClient('getFeeds', ok([makeFeed()]))
        stubClient('getFeedItems', ok([makeFullItem()]))
        const feedStore = useFeedStore()
        const feedItemStore = useFeedItemStore()
        await feedStore.loadFeeds()
        await feedItemStore.loadRecentUnreadItems()
        mountResumeRefresh()

        vi.setSystemTime(Date.now() + 6 * 60_000)   // resumed six minutes later
        await backgroundAndResume()
        expect(vi.mocked(client.getFeeds)).toHaveBeenCalledTimes(2)
        expect(vi.mocked(client.getFeedItems)).toHaveBeenCalledTimes(2)
        vi.useRealTimers()
    })
})

describe('changes made offline', () => {
    it('are sent on resume, without reloading a working queue', async () => {
        const [a, b] = [makeItem(), makeItem()]
        stubClient('getQueue', ok([a, b]))
        stubClient('removeQueueItem', {ok: false, status: null, error: 'Network unavailable'})
        stubClient('modifyFeedItem', {ok: false, status: null, error: 'Network unavailable'})
        const feedItemStore = useFeedItemStore()
        const queueStore = useQueueStore()
        await queueStore.loadQueue()
        await feedItemStore.updateItemProgress(a, 1)
        await queueStore.removeItem(a)
        mountResumeRefresh()

        stubClient('removeQueueItem', ok([b])).mockClear()
        stubClient('modifyFeedItem', ok(undefined)).mockClear()
        await backgroundAndResume()
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(a.guid, {finished: true, progress: 1})
        expect(vi.mocked(client.removeQueueItem)).toHaveBeenCalledExactlyOnceWith(a.guid)
        expect(vi.mocked(client.getQueue)).toHaveBeenCalledOnce()
        expect(queueStore.hasPendingChanges()).toBe(false)
    })

    it('are retried every minute while the app stays open', async () => {
        vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']})
        stubClient('modifyFeedItem', {ok: false, status: null, error: 'Network unavailable'})
        const feedItemStore = useFeedItemStore()
        await feedItemStore.updateItemProgress(makeItem(), 0.5)
        mountResumeRefresh()

        stubClient('modifyFeedItem', ok(undefined)).mockClear()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledOnce()
        expect(await feedItemStore.flushPendingProgress()).toBe(true)
        vi.useRealTimers()
    })
})

describe('on reconnect (offline → online)', () => {
    it('retries failed loads when connectivity returns', async () => {
        stubClient('getFeeds', {ok: false, status: null, error: 'Network unavailable'})
        const feedStore = useFeedStore()
        await feedStore.loadFeeds()
        mountResumeRefresh()
        await goOffline()

        stubClient('getFeeds', ok([makeFeed()]))
        await backOnline()
        expect(feedStore.feedsLoadState).toBe('loaded')
    })
})
