import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {makeFeed, makeItem, mountApp} from '../testing/helpers.ts'
import {useFeedStore} from '../stores/feeds.ts'
import ItemPreview from './ItemPreview.vue'

beforeEach(() => vi.useFakeTimers({toFake: ['Date'], now: new Date('2024-02-01T00:00:00Z')}))
afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('ItemPreview', () => {
    it('renders the unescaped title linking to the item view', async () => {
        const item = makeItem({title: 'Cats &amp; Dogs', guid: 'https://example.com/ep?id=1'})
        const {wrapper} = await mountApp(ItemPreview, {props: {feedItem: item}})

        const link = wrapper.find('h3 a')
        expect(link.text()).toBe('Cats & Dogs')
        // vue-router applies its own RFC-style param encoding; assert it round-trips.
        const href = link.attributes('href')!
        expect(decodeURIComponent(href.replace('/subscriptions/item/', ''))).toBe(item.guid)
    })

    it('shows how long ago the item was posted', async () => {
        const item = makeItem({date: '2024-01-25T00:00:00Z'})
        const {wrapper} = await mountApp(ItemPreview, {props: {feedItem: item}})
        expect(wrapper.find('small').text()).toBe('Posted last week')
    })

    it('links to the source feed once the feed list is loaded, preferring the alias', async () => {
        const feed = makeFeed({title: 'Original Title', alias: 'My Alias'})
        const item = makeItem({source_feed: feed.guid})
        const {wrapper} = await mountApp(ItemPreview, {props: {feedItem: item}})
        useFeedStore().feeds = [feed]
        await wrapper.vm.$nextTick()

        const from = wrapper.find('.subtitle')
        expect(from.text()).toBe('From My Alias')
        expect(from.find('a').attributes('href')).toBe(`/subscriptions/${feed.guid}`)
    })

    it('omits the feed line while the feed is unknown', async () => {
        const {wrapper} = await mountApp(ItemPreview, {props: {feedItem: makeItem()}})
        expect(wrapper.find('.subtitle').exists()).toBe(false)
    })

    it('renders the description as HTML content', async () => {
        const item = makeItem({description: '<em>Emphasised</em> summary'})
        const {wrapper} = await mountApp(ItemPreview, {props: {feedItem: item}})
        expect(wrapper.find('.content em').text()).toBe('Emphasised')
    })

    it('falls back to a placeholder image when the feed has no artwork', async () => {
        const feed = makeFeed({image_src: null})
        const item = makeItem({source_feed: feed.guid})
        const {wrapper} = await mountApp(ItemPreview, {props: {feedItem: item}})
        useFeedStore().feeds = [feed]
        await wrapper.vm.$nextTick()
        expect(wrapper.find('figure img').attributes('src')).toMatch(/^data:image\/svg\+xml,/)
    })
})
