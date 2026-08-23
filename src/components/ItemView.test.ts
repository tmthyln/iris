import {flushPromises} from '@vue/test-utils'
import {afterEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {err, makeFeed, makeFullItem, makeItem, ok, stubClient, mountApp} from '../testing/helpers.ts'
import ItemView from './ItemView.vue'

afterEach(() => vi.restoreAllMocks())

function setup({feedOverrides = {}, itemOverrides = {}, adjacent = {prev: null as ReturnType<typeof makeItem> | null, next: null as ReturnType<typeof makeItem> | null}} = {}) {
    const feed = makeFeed(feedOverrides)
    const item = makeFullItem({source_feed: feed.guid, ...itemOverrides})
    stubClient('getFeeds', ok([feed]))
    stubClient('getFeedItem', ok(item))
    stubClient('getAdjacentFeedItems', ok(adjacent))
    return {feed, item}
}

async function mountItem(guid: string) {
    const mounted = await mountApp(ItemView, {props: {guid}})
    await flushPromises()
    return mounted
}

describe('rendering', () => {
    it('renders the unescaped title as a link with the full content', async () => {
        const {item} = setup({itemOverrides: {
            title: 'Body &amp; Soul',
            link: 'https://example.com/post',
            encoded_content: '<p id="full">The full content</p>',
        }})
        const {wrapper} = await mountItem(item.guid)

        const title = wrapper.find('h1 a')
        expect(title.text()).toBe('Body & Soul')
        expect(title.attributes('href')).toBe('https://example.com/post')
        expect(wrapper.find('#full').text()).toBe('The full content')
    })

    it('shows the feed breadcrumb with season and episode for podcasts', async () => {
        const {feed, item} = setup({
            feedOverrides: {type: 'podcast', title: 'The Podcast'},
            itemOverrides: {season: 2, episode: 14, enclosure_url: 'https://example.com/a.mp3'},
        })
        stubClient('listTranscripts', ok([]))   // AudioControls fetches transcript state
        const {wrapper} = await mountItem(item.guid)

        const breadcrumb = wrapper.find('.breadcrumb')
        expect(breadcrumb.text()).toContain('The Podcast')
        expect(breadcrumb.text()).toContain('Season 2')
        expect(breadcrumb.text()).toContain('Episode 14')
        expect(breadcrumb.find('a[href]').attributes('href')).toBe(`/subscriptions/${feed.guid}`)
    })

    it('renders keyword tags', async () => {
        const {item} = setup({itemOverrides: {keywords: ['tech', 'ai']}})
        const {wrapper} = await mountItem(item.guid)
        expect(wrapper.findAll('.tag').map(t => t.text())).toEqual(['tech', 'ai'])
    })
})

describe('auto-completion of blog posts', () => {
    it('marks an unfinished blog post as read on open', async () => {
        const {item} = setup({feedOverrides: {type: 'blog'}})
        stubClient('modifyFeedItem', ok(undefined))
        await mountItem(item.guid)
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {finished: true})
    })

    it('leaves podcast episodes and finished posts alone', async () => {
        const {item} = setup({feedOverrides: {type: 'podcast'}})
        stubClient('listTranscripts', ok([]))
        const modify = stubClient('modifyFeedItem', ok(undefined))
        await mountItem(item.guid)
        expect(modify).not.toHaveBeenCalled()

        vi.restoreAllMocks()
        const {item: finished} = setup({feedOverrides: {type: 'blog'}, itemOverrides: {finished: true}})
        const modifyAgain = stubClient('modifyFeedItem', ok(undefined))
        await mountItem(finished.guid)
        expect(modifyAgain).not.toHaveBeenCalled()
    })
})

describe('adjacent navigation', () => {
    it('disables the buttons when there is nothing adjacent', async () => {
        const {item} = setup()
        const {wrapper} = await mountItem(item.guid)

        expect(wrapper.find('.adjacent-prev').attributes('disabled')).toBeDefined()
        expect(wrapper.find('.adjacent-next').attributes('disabled')).toBeDefined()
        expect(wrapper.find('.adjacent-prev').text()).toContain('Previous')
    })

    it('labels the buttons with the adjacent titles and navigates on click', async () => {
        const prev = makeItem({title: 'Earlier &amp; Better'})
        const next = makeItem({title: 'Later One'})
        const {item} = setup({adjacent: {prev, next}})
        const {wrapper, router} = await mountItem(item.guid)

        expect(wrapper.find('.adjacent-prev').text()).toContain('Earlier & Better')
        await wrapper.find('.adjacent-next').trigger('click')
        await flushPromises()
        expect(router.currentRoute.value.name).toBe('item')
        expect(router.currentRoute.value.params.guid).toBe(next.guid)
    })

    it('prefetches the adjacent items', async () => {
        const prev = makeItem()
        const {item} = setup({adjacent: {prev, next: null}})
        await mountItem(item.guid)
        const fetched = vi.mocked(client.getFeedItem).mock.calls.map(call => call[0])
        expect(fetched).toContain(prev.guid)
    })
})

describe('failure', () => {
    it('keeps the skeleton when the item cannot be loaded', async () => {
        stubClient('getFeeds', ok([]))
        stubClient('getFeedItem', err(404, 'No feed item found'))
        stubClient('getAdjacentFeedItems', err(404, 'No feed item found'))
        const {wrapper} = await mountItem('missing')
        expect(wrapper.find('h1').text()).toBe('')
    })
})
