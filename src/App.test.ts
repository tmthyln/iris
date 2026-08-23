import {flushPromises} from '@vue/test-utils'
import {IDBFactory} from 'fake-indexeddb'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import client from './client.ts'
import {makeFeed, makeItem, ok, stubClient, mountApp} from './testing/helpers.ts'
import App from './App.vue'

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()   // the download store opens it on init
    localStorage.clear()
    stubClient('getFeeds', ok([makeFeed()]))
    stubClient('getQueue', ok([makeItem()]))
    stubClient('getFeedItems', ok([]))                                  // SidePanel bookmarks
    stubClient('getNotifications', ok({items: [], unreadCount: 0}))     // NotificationBell
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function mountShell() {
    const mounted = await mountApp(App)
    await flushPromises()
    return mounted
}

describe('startup', () => {
    it('loads feeds, queue and downloads on mount', async () => {
        await mountShell()
        expect(vi.mocked(client.getFeeds)).toHaveBeenCalledOnce()
        expect(vi.mocked(client.getQueue)).toHaveBeenCalledOnce()
    })

    it('hides the offline banner while online', async () => {
        const {wrapper} = await mountShell()
        expect(wrapper.find('.offline-banner').exists()).toBe(false)
    })

    it('shows the offline banner when the connection is lost', async () => {
        const {wrapper} = await mountShell()
        Object.defineProperty(navigator, 'onLine', {configurable: true, value: false})
        window.dispatchEvent(new Event('offline'))
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.offline-banner').text()).toContain("You're offline")
        Reflect.deleteProperty(navigator, 'onLine')
    })
})

describe('mobile sidebar', () => {
    it('opens with the burger and closes after navigating', async () => {
        const {wrapper, router} = await mountShell()
        expect(wrapper.find('.sidebar').classes()).toContain('is-hidden-mobile')

        await wrapper.find('.navbar-burger').trigger('click')
        expect(wrapper.find('.sidebar').classes()).not.toContain('is-hidden-mobile')
        expect(wrapper.find('.sidebar-backdrop').exists()).toBe(true)

        await router.push('/downloads')
        await flushPromises()
        expect(wrapper.find('.sidebar').classes()).toContain('is-hidden-mobile')
    })
})

describe('external links', () => {
    it('opens cross-origin links in a new tab instead of navigating', async () => {
        const {wrapper} = await mountShell()
        const open = vi.fn()
        vi.stubGlobal('open', open)

        const anchor = document.createElement('a')
        anchor.href = 'https://elsewhere.example/article'
        ;(wrapper.element as HTMLElement).appendChild(anchor)
        anchor.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))

        expect(open).toHaveBeenCalledExactlyOnceWith('https://elsewhere.example/article', '_blank', 'noopener')
    })

    it('leaves same-origin links to the router', async () => {
        const {wrapper} = await mountShell()
        const open = vi.fn()
        vi.stubGlobal('open', open)

        const anchor = document.createElement('a')
        anchor.href = `${location.origin}/subscriptions/abc`
        ;(wrapper.element as HTMLElement).appendChild(anchor)
        anchor.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))

        expect(open).not.toHaveBeenCalled()
    })
})
