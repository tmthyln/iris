import {flushPromises, type VueWrapper} from '@vue/test-utils'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {makeItem, ok, stubClient, mountApp} from '../testing/helpers.ts'
import NavBar from './NavBar.vue'

beforeEach(() => {
    // The debounced search sits on the fake clock; keep Date real for vueuse.
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']})
    stubClient('getNotifications', ok({items: [], unreadCount: 0}))   // NotificationBell child
})
afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
})

async function openSearch(wrapper: VueWrapper) {
    await wrapper.find('.navbar-menu input').trigger('click')
    expect(wrapper.find('.modal').classes()).toContain('is-active')
    return wrapper.find('.modal input')
}

async function typeSearch(wrapper: VueWrapper, text: string) {
    const input = await openSearch(wrapper)
    await input.setValue(text)
    await vi.advanceTimersByTimeAsync(300)   // debounce
    await flushPromises()
    return input
}

describe('opening and closing', () => {
    it('opens from the navbar and closes via the background', async () => {
        const {wrapper} = await mountApp(NavBar)
        await openSearch(wrapper)
        await wrapper.find('.modal-background').trigger('click')
        expect(wrapper.find('.modal').classes()).not.toContain('is-active')
    })

    it('opens in command mode when "/" is pressed anywhere', async () => {
        const {wrapper} = await mountApp(NavBar)
        window.dispatchEvent(new KeyboardEvent('keydown', {key: '/'}))
        await wrapper.vm.$nextTick()

        expect(wrapper.find('.modal').classes()).toContain('is-active')
        const input = wrapper.find('.modal input').element as HTMLInputElement
        expect(input.value).toBe('/')
        expect(wrapper.find('.command-item').text()).toContain('/refresh all')
    })

    it('does not steal "/" from form fields', async () => {
        const {wrapper} = await mountApp(NavBar)
        const field = document.createElement('input')
        document.body.append(field)
        field.dispatchEvent(new KeyboardEvent('keydown', {key: '/', bubbles: true}))
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.modal').classes()).not.toContain('is-active')
        field.remove()
    })
})

describe('searching', () => {
    it('searches after the debounce and renders highlighted results', async () => {
        const result = makeItem({title: 'Deep needle dive', description: 'A story about a needle in a haystack'})
        stubClient('searchFeedItems', ok([result]))
        const {wrapper} = await mountApp(NavBar)

        await typeSearch(wrapper, 'needle')
        expect(vi.mocked(client.searchFeedItems)).toHaveBeenCalledExactlyOnceWith('needle', {limit: 20, offset: 0})

        const hit = wrapper.find('.search-result')
        expect(hit.find('.search-result-title mark').text()).toBe('needle')
        expect(hit.find('.search-result-snippet mark').text()).toBe('needle')
    })

    it('does not search for fewer than three characters', async () => {
        stubClient('searchFeedItems', ok([]))
        const {wrapper} = await mountApp(NavBar)
        await typeSearch(wrapper, 'ne')
        expect(vi.mocked(client.searchFeedItems)).not.toHaveBeenCalled()
        expect(wrapper.text()).toContain('Type at least 3 characters to search')
    })

    it('hides the results panel when nothing matches', async () => {
        // The "No results found" branch is unreachable: the panel itself renders only
        // while there are results or a search is loading. Pin the actual behaviour.
        stubClient('searchFeedItems', ok([]))
        const {wrapper} = await mountApp(NavBar)
        await typeSearch(wrapper, 'nothing here')
        expect(wrapper.find('.search-results').exists()).toBe(false)
    })

    it('opens a clicked result and closes the modal', async () => {
        const result = makeItem({title: 'The needle episode'})
        stubClient('searchFeedItems', ok([result]))
        const {wrapper, router} = await mountApp(NavBar)

        await typeSearch(wrapper, 'needle')
        await wrapper.find('.search-result').trigger('click')
        await flushPromises()
        expect(router.currentRoute.value.name).toBe('item')
        expect(router.currentRoute.value.params.guid).toBe(result.guid)
        expect(wrapper.find('.modal').classes()).not.toContain('is-active')
    })

    it('navigates results with the arrow keys and opens with Enter', async () => {
        const [first, second] = [makeItem({title: 'needle one'}), makeItem({title: 'needle two'})]
        stubClient('searchFeedItems', ok([first, second]))
        const {wrapper, router} = await mountApp(NavBar)

        const input = await typeSearch(wrapper, 'needle')
        await input.trigger('keydown', {key: 'ArrowDown'})
        await input.trigger('keydown', {key: 'ArrowDown'})
        expect(wrapper.findAll('.search-result')[1].classes()).toContain('is-selected')

        await input.trigger('keyup.enter')
        await flushPromises()
        expect(router.currentRoute.value.params.guid).toBe(second.guid)
    })
})

describe('commands', () => {
    it('filters the command palette while typing', async () => {
        const {wrapper} = await mountApp(NavBar)
        const input = await openSearch(wrapper)
        await input.setValue('/refresh')
        expect(wrapper.find('.command-item').text()).toContain('Refresh all feed subscriptions')

        await input.setValue('/nonsense')
        expect(wrapper.find('.command-item').exists()).toBe(false)
    })

    it('runs "refresh all" from the palette', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        stubClient('refreshAllFeeds', ok({refreshedCount: 4}))
        const {wrapper} = await mountApp(NavBar)

        const input = await openSearch(wrapper)
        await input.setValue('/refresh all')
        await wrapper.find('.command-item').trigger('click')
        await flushPromises()

        expect(vi.mocked(client.refreshAllFeeds)).toHaveBeenCalledOnce()
        expect(wrapper.find('.modal').classes()).not.toContain('is-active')
    })
})
