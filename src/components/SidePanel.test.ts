import {flushPromises} from '@vue/test-utils'
import {afterEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {useFeedItemStore} from '../stores/feeditems.ts'
import {useFeedStore} from '../stores/feeds.ts'
import {useDownloadStore} from '../stores/downloads.ts'
import {makeFeed, makeFullItem, makeItem, ok, stubClient, mountApp} from '../testing/helpers.ts'
import SidePanel from './SidePanel.vue'

afterEach(() => vi.restoreAllMocks())

async function mountPanel({bookmarked = ok([]) as Awaited<ReturnType<typeof client.getFeedItems>>} = {}) {
    stubClient('getFeedItems', bookmarked)
    const mounted = await mountApp(SidePanel)
    await flushPromises()
    return mounted
}

describe('feed list', () => {
    it('shows a loading message while feeds load', async () => {
        const {wrapper} = await mountPanel()
        useFeedStore().feedsLoadState = 'loading'
        await wrapper.vm.$nextTick()
        expect(wrapper.text()).toContain('Loading feeds...')
    })

    it('prompts to add a feed when there are none', async () => {
        const {wrapper} = await mountPanel()
        expect(wrapper.text()).toContain('No feeds! Add a feed to get started.')
    })

    it('prompts to categorise when no feed has a category', async () => {
        const {wrapper} = await mountPanel()
        useFeedStore().feeds = [makeFeed({categories: []})]
        await wrapper.vm.$nextTick()
        expect(wrapper.text()).toContain('No categories!')
    })

    it('renders category groups with links to each feed, dimming read feeds', async () => {
        const {wrapper} = await mountPanel()
        const unread = makeFeed({categories: ['Tech'], has_unread: true})
        const read = makeFeed({categories: ['Tech'], has_unread: false, alias: 'Read Feed'})
        useFeedStore().feeds = [unread, read]
        await wrapper.vm.$nextTick()

        expect(wrapper.find('.menu-label').text()).toBe('Tech')
        const links = wrapper.findAll('.menu-list a').filter(a => a.attributes('href')?.startsWith('/subscriptions/'))
        expect(links.map(a => a.text())).toEqual([unread.title, 'Read Feed'])
        expect(links[0].classes()).not.toContain('has-text-grey')
        expect(links[1].classes()).toContain('has-text-grey')
    })
})

describe('downloads link', () => {
    it('shows the number of downloaded items when there are any', async () => {
        const {wrapper} = await mountPanel()
        expect(wrapper.find('.tag').exists()).toBe(false)

        const downloadStore = useDownloadStore()
        downloadStore.downloadedItems['item-1'] = makeItem()
        downloadStore.downloadedItems['item-2'] = makeItem()
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.tag').text()).toBe('2')
    })
})

describe('bookmarks', () => {
    it('loads bookmarked items on mount and lists them', async () => {
        const items = [makeFullItem({bookmarked: true}), makeFullItem({bookmarked: true})]
        const {wrapper} = await mountPanel({bookmarked: ok(items)})

        expect(vi.mocked(client.getFeedItems)).toHaveBeenCalledExactlyOnceWith({bookmarked: true})
        const links = wrapper.findAll('a').filter(a => a.attributes('href')?.startsWith('/subscriptions/item/'))
        expect(links.map(a => a.text())).toEqual(items.map(i => i.title))
    })

    it('shows an empty state when nothing is bookmarked', async () => {
        const {wrapper} = await mountPanel()
        expect(wrapper.text()).toContain('No bookmarks!')
    })

    it('unbookmarks an item from the panel', async () => {
        const item = makeFullItem({bookmarked: true})
        const {wrapper} = await mountPanel({bookmarked: ok([item])})
        stubClient('modifyFeedItem', ok(undefined))

        await wrapper.find('span[title="Unbookmark this item"]').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {bookmarked: false})
        expect(useFeedItemStore().bookmarkedItems).toEqual([])
    })
})
