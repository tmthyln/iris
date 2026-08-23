import {createPinia, setActivePinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {err, makeFeed, ok, stubClient, stubClientPending} from '../testing/helpers.ts'
import {useFeedStore} from './feeds.ts'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.restoreAllMocks())

describe('loadFeeds', () => {
    it('loads feeds and flushes queued callbacks', async () => {
        const feeds = [makeFeed(), makeFeed()]
        stubClient('getFeeds', ok(feeds))
        const store = useFeedStore()

        const callback = vi.fn()
        const loading = store.loadFeeds()
        void store.afterFeedsLoaded(callback)   // queued while loading
        expect(store.feedsLoadState).toBe('loading')
        expect(callback).not.toHaveBeenCalled()

        await loading
        expect(store.feedsLoadState).toBe('loaded')
        expect(store.feeds).toEqual(feeds)
        expect(callback).toHaveBeenCalledOnce()
    })

    it('returns to unloaded on failure', async () => {
        stubClient('getFeeds', err(500, 'boom'))
        const store = useFeedStore()
        await store.loadFeeds()
        expect(store.feedsLoadState).toBe('unloaded')
        expect(store.feeds).toEqual([])
    })

    it('does not start a second request while one is in flight', async () => {
        const {spy, resolve} = stubClientPending('getFeeds')
        const store = useFeedStore()
        const first = store.loadFeeds()
        const second = store.loadFeeds()
        resolve(ok([makeFeed()]))
        await Promise.all([first, second])
        expect(spy).toHaveBeenCalledOnce()
    })
})

describe('afterFeedsLoaded', () => {
    it('runs immediately when feeds are already loaded', async () => {
        stubClient('getFeeds', ok([makeFeed()]))
        const store = useFeedStore()
        await store.loadFeeds()

        const callback = vi.fn()
        await store.afterFeedsLoaded(callback)
        expect(callback).toHaveBeenCalledOnce()
        expect(vi.mocked(client.getFeeds)).toHaveBeenCalledOnce()   // no reload
    })

    it('triggers a load when unloaded', async () => {
        stubClient('getFeeds', ok([makeFeed()]))
        const store = useFeedStore()
        const callback = vi.fn()
        await store.afterFeedsLoaded(callback)
        expect(store.feedsLoadState).toBe('loaded')
        expect(callback).toHaveBeenCalledOnce()
    })
})

describe('getters', () => {
    it('collects sorted unique categories', () => {
        const store = useFeedStore()
        store.feeds = [
            makeFeed({categories: ['Tech', 'News']}),
            makeFeed({categories: ['News']}),
            makeFeed({categories: []}),
        ]
        expect(store.allCategories).toEqual(['News', 'Tech'])
    })

    it('groups feeds by category, Uncategorized first, sorted naturally', () => {
        const store = useFeedStore()
        const uncategorized = makeFeed({title: 'Zulu', categories: []})
        const b = makeFeed({title: 'b feed', categories: ['beta']})
        const a10 = makeFeed({title: 'Show 10', categories: ['Alpha']})
        const a2 = makeFeed({title: 'Show 2', categories: ['Alpha']})
        const aliased = makeFeed({title: 'ZZZ', alias: 'AAA', categories: ['Alpha']})
        store.feeds = [uncategorized, b, a10, a2, aliased]

        const groups = store.feedsByCategory
        expect(Object.keys(groups)).toEqual(['Uncategorized', 'Alpha', 'beta'])
        // alias wins for display sorting; numeric-aware compare puts 2 before 10
        expect(groups['Alpha'].map(f => f.alias || f.title)).toEqual(['AAA', 'Show 2', 'Show 10'])
        expect(groups['Uncategorized']).toEqual([uncategorized])
    })

    it('drops the Uncategorized group when every feed has categories', () => {
        const store = useFeedStore()
        store.feeds = [makeFeed({categories: ['One']})]
        expect(Object.keys(store.feedsByCategory)).toEqual(['One'])
    })

    it('a feed in several categories appears in each', () => {
        const store = useFeedStore()
        const feed = makeFeed({categories: ['A', 'B']})
        store.feeds = [feed]
        expect(store.feedsByCategory['A']).toEqual([feed])
        expect(store.feedsByCategory['B']).toEqual([feed])
    })
})

describe('single-feed actions', () => {
    it('getFeedById finds a feed or returns null', () => {
        const store = useFeedStore()
        const feed = makeFeed()
        store.feeds = [feed]
        expect(store.getFeedById(feed.guid)).toEqual(feed)
        expect(store.getFeedById('nope')).toBeNull()
    })

    it('refreshFeed delegates to the client', async () => {
        stubClient('refreshFeed', ok(undefined))
        const store = useFeedStore()
        await store.refreshFeed('feed-1')
        expect(vi.mocked(client.refreshFeed)).toHaveBeenCalledExactlyOnceWith('feed-1')
    })

    it('planFeedArchives marks the feed as having archives', async () => {
        stubClient('planFeedArchives', ok(undefined, 202))
        const store = useFeedStore()
        const feed = makeFeed({has_archives: false})
        store.feeds = [feed]
        await store.planFeedArchives(feed.guid)
        expect(store.feeds[0].has_archives).toBe(true)
    })

    it('updateFeedAlias applies the alias only on success', async () => {
        const store = useFeedStore()
        const feed = makeFeed({alias: 'old'})
        store.feeds = [feed]

        stubClient('modifyFeed', ok(undefined))
        expect(await store.updateFeedAlias(feed.guid, 'new')).toBe(true)
        expect(store.feeds[0].alias).toBe('new')

        stubClient('modifyFeed', err())
        expect(await store.updateFeedAlias(feed.guid, 'newer')).toBe(false)
        expect(store.feeds[0].alias).toBe('new')
    })

    it('updateFeedCategories applies the categories only on success', async () => {
        const store = useFeedStore()
        const feed = makeFeed({categories: ['old']})
        store.feeds = [feed]

        stubClient('modifyFeed', ok(undefined))
        expect(await store.updateFeedCategories(feed.guid, ['a', 'b'])).toBe(true)
        expect(store.feeds[0].categories).toEqual(['a', 'b'])
        expect(vi.mocked(client.modifyFeed)).toHaveBeenCalledWith(feed.guid, {categories: ['a', 'b']})
    })

    it('setNotifyEnabled is optimistic and rolls back on failure', async () => {
        const store = useFeedStore()
        const feed = makeFeed({notify_enabled: false})
        store.feeds = [feed]

        const {resolve} = stubClientPending('modifyFeed')
        const call = store.setNotifyEnabled(feed.guid, true)
        expect(store.feeds[0].notify_enabled).toBe(true)   // optimistic
        resolve(err())
        expect(await call).toBe(false)
        expect(store.feeds[0].notify_enabled).toBe(false)  // rolled back
    })
})
