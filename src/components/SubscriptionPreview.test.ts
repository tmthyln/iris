import {describe, expect, it} from 'vitest'
import {makeFeed, mountApp} from '../testing/helpers.ts'
import SubscriptionPreview from './SubscriptionPreview.vue'

describe('SubscriptionPreview', () => {
    it('links the whole card to the subscription view', async () => {
        const feed = makeFeed()
        const {wrapper} = await mountApp(SubscriptionPreview, {props: {feed}})
        expect(wrapper.find('a').attributes('href')).toBe(`/subscriptions/${feed.guid}`)
    })

    it('prefers the alias over the (unescaped) title', async () => {
        const feed = makeFeed({title: 'Tom &amp; Jerry', alias: ''})
        const {wrapper} = await mountApp(SubscriptionPreview, {props: {feed}})
        expect(wrapper.find('figcaption div').text()).toBe('Tom & Jerry')

        const aliased = makeFeed({title: 'Whatever', alias: 'Shortname'})
        const {wrapper: aliasedWrapper} = await mountApp(SubscriptionPreview, {props: {feed: aliased}})
        expect(aliasedWrapper.find('figcaption div').text()).toBe('Shortname')
    })

    it('shows the author only when it adds information', async () => {
        const withAuthor = makeFeed({title: 'The Show', author: 'Jane Host'})
        const {wrapper} = await mountApp(SubscriptionPreview, {props: {feed: withAuthor}})
        expect(wrapper.find('figcaption small').text()).toBe('Jane Host')

        const selfTitled = makeFeed({title: 'Jane Host', author: 'Jane Host'})
        const {wrapper: selfTitledWrapper} = await mountApp(SubscriptionPreview, {props: {feed: selfTitled}})
        expect(selfTitledWrapper.find('figcaption small').exists()).toBe(false)

        const noAuthor = makeFeed({author: ' '})
        const {wrapper: noAuthorWrapper} = await mountApp(SubscriptionPreview, {props: {feed: noAuthor}})
        expect(noAuthorWrapper.find('figcaption small').exists()).toBe(false)
    })

    it('uses the feed image when present and a placeholder otherwise', async () => {
        const withImage = makeFeed({image_src: 'https://example.com/cover.jpg'})
        const {wrapper} = await mountApp(SubscriptionPreview, {props: {feed: withImage}})
        expect(wrapper.find('img').attributes('src')).toBe('https://example.com/cover.jpg')

        const bare = makeFeed({image_src: null})
        const {wrapper: bareWrapper} = await mountApp(SubscriptionPreview, {props: {feed: bare}})
        expect(bareWrapper.find('img').attributes('src')).toMatch(/^data:image\/svg\+xml,/)
    })
})
