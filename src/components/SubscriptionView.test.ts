import {flushPromises} from '@vue/test-utils'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {useFeedStore} from '../stores/feeds.ts'
import {makeFeed, makeFullItem, ok, stubClient, mountApp} from '../testing/helpers.ts'
import SubscriptionView from './SubscriptionView.vue'

beforeEach(() => sessionStorage.clear())   // showFinished / sortAscending persist there
afterEach(() => vi.restoreAllMocks())

async function mountSubscription({feed = makeFeed(), items = [] as ReturnType<typeof makeFullItem>[], moreFeeds = [] as ReturnType<typeof makeFeed>[]} = {}) {
    stubClient('getFeedFeedItems', ok(items))
    const mounted = await mountApp(SubscriptionView, {props: {guid: feed.guid}})
    useFeedStore().feeds = [feed, ...moreFeeds]
    await flushPromises()
    return {...mounted, feed}
}

describe('header', () => {
    it('shows a loading title until the feed list arrives', async () => {
        stubClient('getFeedFeedItems', ok([]))
        const {wrapper} = await mountApp(SubscriptionView, {props: {guid: 'unknown'}})
        expect(wrapper.find('h1').text()).toBe('Loading subscription...')
    })

    it('renders name, author, description and update frequency', async () => {
        const feed = makeFeed({
            title: 'The Feed', alias: '', author: 'Jane &amp; John', link: 'https://example.com/',
            description: 'All the news.', update_frequency: 3,
        })
        const {wrapper} = await mountSubscription({feed})

        expect(wrapper.find('h1 a').text()).toBe('The Feed')
        expect(wrapper.find('h1 a').attributes('href')).toBe('https://example.com/')
        expect(wrapper.find('.subtitle').text()).toBe('Jane & John')
        expect(wrapper.text()).toContain('All the news.')
        expect(wrapper.text()).toContain('Updates about once every 3 days.')
    })
})

describe('item pages', () => {
    it('requests the first page unfinished-first, newest-first', async () => {
        const items = [makeFullItem(), makeFullItem()]
        const {wrapper, feed} = await mountSubscription({items})
        expect(vi.mocked(client.getFeedFeedItems)).toHaveBeenCalledExactlyOnceWith(
            feed.guid, {includeFinished: false, sortOrder: 'desc', limit: 20, offset: 0})
        expect(wrapper.text()).toContain(items[0].title)
        expect(wrapper.find('h2').text()).toBe('Unseen Posts')
    })

    it('refetches including finished items when toggled', async () => {
        const {wrapper} = await mountSubscription()
        await wrapper.find('[title="Show finished items"]').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.getFeedFeedItems)).toHaveBeenLastCalledWith(
            expect.any(String), expect.objectContaining({includeFinished: true}))
        expect(wrapper.find('h2').text()).toBe('All Posts')
    })

    it('refetches oldest-first when the sort is flipped', async () => {
        const {wrapper} = await mountSubscription()
        await wrapper.find('[title="Sort by earliest items first"]').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.getFeedFeedItems)).toHaveBeenLastCalledWith(
            expect.any(String), expect.objectContaining({sortOrder: 'asc'}))
    })

    it('shows a caught-up message when every item is read', async () => {
        const {wrapper} = await mountSubscription({items: []})
        expect(wrapper.text()).toContain("No unseen posts. You're all caught up!")
    })
})

describe('categories', () => {
    it('adds a category (commas stripped) through the feed store', async () => {
        stubClient('modifyFeed', ok(undefined))
        const {wrapper, feed} = await mountSubscription({feed: makeFeed({categories: ['Old']})})

        const input = wrapper.find('input[placeholder="Add category"]')
        await input.setValue('Ne,ws')
        await input.trigger('input')
        await input.trigger('keydown.enter')
        await flushPromises()

        expect(vi.mocked(client.modifyFeed)).toHaveBeenCalledExactlyOnceWith(feed.guid, {categories: ['Old', 'News']})
    })

    it('suggests categories from other feeds and adds the selected one', async () => {
        stubClient('modifyFeed', ok(undefined))
        const other = makeFeed({categories: ['Music', 'News']})
        const {wrapper, feed} = await mountSubscription({feed: makeFeed({categories: ['News']}), moreFeeds: [other]})

        await wrapper.find('input[placeholder="Add category"]').trigger('focus')
        const suggestions = wrapper.findAll('.category-suggestion')
        expect(suggestions.map(s => s.text())).toEqual(['Music'])   // 'News' already applied

        await suggestions[0].trigger('mousedown')
        await flushPromises()
        expect(vi.mocked(client.modifyFeed)).toHaveBeenCalledExactlyOnceWith(feed.guid, {categories: ['News', 'Music']})
    })

    it('removes a category from its tag', async () => {
        stubClient('modifyFeed', ok(undefined))
        const {wrapper, feed} = await mountSubscription({feed: makeFeed({categories: ['Keep', 'Drop']})})

        const dropTag = wrapper.findAll('.tag').find(tag => tag.text() === 'Drop')!
        await dropTag.find('.delete').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.modifyFeed)).toHaveBeenCalledExactlyOnceWith(feed.guid, {categories: ['Keep']})
    })
})

describe('alias editing', () => {
    it('saves a new alias on enter', async () => {
        stubClient('modifyFeed', ok(undefined))
        const {wrapper, feed} = await mountSubscription({feed: makeFeed({title: 'Original', alias: ''})})

        await wrapper.find('.edit-alias-icon').trigger('click')
        const input = wrapper.find('h1 input')
        expect((input.element as HTMLInputElement).value).toBe('Original')

        await input.setValue('Nickname')
        await input.trigger('keydown.enter')
        await flushPromises()
        expect(vi.mocked(client.modifyFeed)).toHaveBeenCalledExactlyOnceWith(feed.guid, {alias: 'Nickname'})
        expect(wrapper.find('h1').text()).toContain('Nickname')
    })

    it('clears the alias when it is set back to the title', async () => {
        stubClient('modifyFeed', ok(undefined))
        const {wrapper, feed} = await mountSubscription({feed: makeFeed({title: 'Original', alias: 'Nickname'})})

        await wrapper.find('.edit-alias-icon').trigger('click')
        const input = wrapper.find('h1 input')
        await input.setValue('Original')
        await input.trigger('blur')
        await flushPromises()
        expect(vi.mocked(client.modifyFeed)).toHaveBeenCalledExactlyOnceWith(feed.guid, {alias: ''})
    })
})

describe('feed actions', () => {
    it('refreshes the feed from the menu', async () => {
        stubClient('refreshFeed', ok(undefined, 202))
        const {wrapper, feed} = await mountSubscription()

        await wrapper.find('[title="Feed actions"]').trigger('click')
        expect(wrapper.find('.dropdown').classes()).toContain('is-active')
        await wrapper.findAll('.dropdown-item').find(a => a.text().includes('Refresh Feed'))!.trigger('click')
        await flushPromises()

        expect(vi.mocked(client.refreshFeed)).toHaveBeenCalledExactlyOnceWith(feed.guid)
        expect(wrapper.find('.dropdown').classes()).not.toContain('is-active')
    })

    it('plans archives once and then hides the menu entry', async () => {
        stubClient('planFeedArchives', ok(undefined, 202))
        const {wrapper, feed} = await mountSubscription({feed: makeFeed({has_archives: false})})

        await wrapper.find('[title="Feed actions"]').trigger('click')
        await wrapper.findAll('.dropdown-item').find(a => a.text().includes('Fetch Archives'))!.trigger('click')
        await flushPromises()

        expect(vi.mocked(client.planFeedArchives)).toHaveBeenCalledExactlyOnceWith(feed.guid)
        await wrapper.find('[title="Feed actions"]').trigger('click')
        expect(wrapper.findAll('.dropdown-item').some(a => a.text().includes('Fetch Archives'))).toBe(false)
    })

    it('toggles notifications for the feed', async () => {
        stubClient('modifyFeed', ok(undefined))
        const {wrapper, feed} = await mountSubscription({feed: makeFeed({notify_enabled: false})})

        await wrapper.find('input[type=checkbox]').setValue(true)
        await flushPromises()
        expect(vi.mocked(client.modifyFeed)).toHaveBeenCalledExactlyOnceWith(feed.guid, {notify_enabled: true})
    })
})
