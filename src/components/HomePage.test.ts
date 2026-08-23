import {flushPromises} from '@vue/test-utils'
import {afterEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {useFeedItemStore} from '../stores/feeditems.ts'
import {useFeedStore} from '../stores/feeds.ts'
import {err, makeFeed, makeFullItem, ok, stubClient, mountApp} from '../testing/helpers.ts'
import HomePage from './HomePage.vue'

afterEach(() => vi.restoreAllMocks())

async function mountHome(recent: ReturnType<typeof makeFullItem>[] = []) {
    stubClient('getFeedItems', ok(recent))
    const mounted = await mountApp(HomePage)
    await flushPromises()
    return mounted
}

describe('subscribed feeds strip', () => {
    it('shows only feeds with unread items', async () => {
        const {wrapper} = await mountHome()
        const unread = makeFeed({has_unread: true, title: 'Has News'})
        const read = makeFeed({has_unread: false, title: 'All Caught Up'})
        useFeedStore().feeds = [unread, read]
        await wrapper.vm.$nextTick()

        expect(wrapper.text()).toContain('Has News')
        expect(wrapper.text()).not.toContain('All Caught Up')
    })

    it('prompts to subscribe when a load found no feeds', async () => {
        const {wrapper} = await mountHome()
        useFeedStore().feedsLoadState = 'loaded'
        await wrapper.vm.$nextTick()
        expect(wrapper.text()).toContain("You aren't subscribed to any feeds!")
    })

    it('offers a retry instead of claiming "no feeds" when the load failed', async () => {
        const {wrapper} = await mountHome()
        const feedStore = useFeedStore()
        feedStore.feedsLoadState = 'error'
        await wrapper.vm.$nextTick()
        expect(wrapper.text()).toContain("Couldn't load your feeds.")
        expect(wrapper.text()).not.toContain("You aren't subscribed")

        stubClient('getFeeds', ok([makeFeed({title: 'Recovered Feed'})]))
        await wrapper.findAll('button').find(b => b.text() === 'Retry')!.trigger('click')
        await flushPromises()
        expect(wrapper.text()).toContain('Recovered Feed')
    })
})

describe('recent unread items', () => {
    it('loads the recent items on mount and renders them', async () => {
        const items = [makeFullItem(), makeFullItem()]
        const {wrapper} = await mountHome(items)
        expect(vi.mocked(client.getFeedItems)).toHaveBeenCalledExactlyOnceWith({limit: 20})
        expect(wrapper.text()).toContain(items[0].title)
        expect(wrapper.text()).toContain(items[1].title)
    })

    it('celebrates inbox zero', async () => {
        const {wrapper} = await mountHome([])
        expect(useFeedItemStore().recentLoadState).toBe('loaded')
        expect(wrapper.text()).toContain('Yay, inbox zero!')
    })

    it('offers a retry instead of claiming inbox zero when the load failed', async () => {
        stubClient('getFeedItems', err(null, 'Network unavailable'))
        const mounted = await mountApp(HomePage)
        await flushPromises()
        const {wrapper} = mounted
        expect(wrapper.text()).toContain("Couldn't load your items.")
        expect(wrapper.text()).not.toContain('inbox zero')

        const item = makeFullItem({title: 'Recovered Item'})
        stubClient('getFeedItems', ok([item]))
        await wrapper.findAll('button').find(b => b.text() === 'Retry')!.trigger('click')
        await flushPromises()
        expect(wrapper.text()).toContain('Recovered Item')
    })
})

describe('feed adder', () => {
    it('submits a URL, defaulting the scheme to https', async () => {
        stubClient('addFeed', ok(undefined, 201))
        const {wrapper} = await mountHome()

        await wrapper.findAll('button').find(b => b.text() === 'Add Feed')!.trigger('click')
        expect(wrapper.find('.modal').classes()).toContain('is-active')

        await wrapper.find('input[type=url]').setValue('example.com/feed.xml')
        await wrapper.find('input[type=url]').trigger('keyup.enter')
        await flushPromises()

        expect(vi.mocked(client.addFeed)).toHaveBeenCalledExactlyOnceWith('https://example.com/feed.xml')
        expect(wrapper.find('.modal').classes()).not.toContain('is-active')
    })

    it('closes without a request when the URL is empty', async () => {
        stubClient('addFeed', ok(undefined, 201))
        const {wrapper} = await mountHome()

        await wrapper.findAll('button').find(b => b.text() === 'Add Feed')!.trigger('click')
        await wrapper.findAll('button').find(b => b.text() === 'Submit')!.trigger('click')
        await flushPromises()

        expect(vi.mocked(client.addFeed)).not.toHaveBeenCalled()
        expect(wrapper.find('.modal').classes()).not.toContain('is-active')
    })

    it('imports every outline of an OPML file, then reloads the feed list', async () => {
        stubClient('addFeed', ok(undefined, 201))
        stubClient('getFeeds', ok([]))
        const {wrapper} = await mountHome()
        await wrapper.findAll('button').find(b => b.text() === 'Add Feed')!.trigger('click')

        const opml = `<?xml version="1.0"?><opml version="2.0"><body>
            <outline text="Feed One" xmlUrl="https://one.example/rss" />
            <outline text="Group"><outline text="Feed Two" xmlUrl="https://two.example/rss" /></outline>
            <outline text="Not a feed" />
        </body></opml>`
        const file = new File([opml], 'subscriptions.opml', {type: 'text/xml'})
        const input = wrapper.find('input[type=file]')
        Object.defineProperty(input.element, 'files', {value: [file]})
        await input.trigger('change')

        await vi.waitFor(() => {
            expect(vi.mocked(client.addFeed).mock.calls.map(call => call[0]))
                .toEqual(['https://one.example/rss', 'https://two.example/rss'])
        })
        await flushPromises()
        expect(vi.mocked(client.getFeeds)).toHaveBeenCalledOnce()
        expect(wrapper.find('.modal').classes()).not.toContain('is-active')
    })
})
