import {flushPromises} from '@vue/test-utils'
import {afterEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {useNotificationStore} from '../stores/notifications.ts'
import {makeNotification, makeSubscription, ok, stubBrowserPush, stubClient, mountApp} from '../testing/helpers.ts'
import NotificationBell from './NotificationBell.vue'

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'serviceWorker')
})

async function mountBell(notifications = {items: [] as ReturnType<typeof makeNotification>[], unreadCount: 0}) {
    stubClient('getNotifications', ok(notifications))
    const mounted = await mountApp(NotificationBell)
    await flushPromises()
    return mounted
}

describe('badge', () => {
    it('loads notifications on mount and shows the unread count', async () => {
        const {wrapper} = await mountBell({items: [makeNotification()], unreadCount: 3})
        expect(vi.mocked(client.getNotifications)).toHaveBeenCalledOnce()
        expect(wrapper.find('.bell-badge').text()).toBe('3')
    })

    it('hides the badge at zero and caps it at 9+', async () => {
        const {wrapper} = await mountBell()
        expect(wrapper.find('.bell-badge').exists()).toBe(false)

        useNotificationStore().unreadCount = 12
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.bell-badge').text()).toBe('9+')
    })
})

describe('dropdown', () => {
    it('opens on click and reloads the list', async () => {
        const {wrapper} = await mountBell()
        expect(wrapper.find('.bell-dropdown').exists()).toBe(false)

        await wrapper.find('.bell-trigger').trigger('click')
        expect(wrapper.find('.bell-dropdown').exists()).toBe(true)
        expect(wrapper.text()).toContain("You're all caught up.")
        expect(vi.mocked(client.getNotifications)).toHaveBeenCalledTimes(2)
    })

    it('lists notifications with the feed label and an Updated tag where relevant', async () => {
        const fresh = makeNotification({item_title: 'New Episode', feed_title: 'The Feed', feed_alias: null})
        const updated = makeNotification({type: 'updated_item', item_title: 'Old Post', feed_alias: 'Alias'})
        const {wrapper} = await mountBell({items: [fresh, updated], unreadCount: 2})
        await wrapper.find('.bell-trigger').trigger('click')

        const rows = wrapper.findAll('.bell-item')
        expect(rows).toHaveLength(2)
        expect(rows[0].text()).toContain('New Episode')
        expect(rows[0].text()).toContain('The Feed')
        expect(rows[0].find('.tag').exists()).toBe(false)
        expect(rows[1].text()).toContain('Alias')
        expect(rows[1].find('.tag').text()).toBe('Updated')
    })

    it('dismisses a single notification', async () => {
        const item = makeNotification()
        stubClient('dismissNotification', ok(undefined))
        const {wrapper} = await mountBell({items: [item], unreadCount: 1})
        await wrapper.find('.bell-trigger').trigger('click')

        await wrapper.find('.bell-item .delete').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.dismissNotification)).toHaveBeenCalledExactlyOnceWith(item.id)
        expect(wrapper.find('.bell-item').classes()).toContain('is-dismissed')
        expect(wrapper.find('.bell-badge').exists()).toBe(false)
    })

    it('marks everything read', async () => {
        stubClient('dismissAllNotifications', ok(undefined))
        const {wrapper} = await mountBell({items: [makeNotification(), makeNotification()], unreadCount: 2})
        await wrapper.find('.bell-trigger').trigger('click')

        const markAll = wrapper.findAll('button').find(b => b.text() === 'Mark all read')!
        await markAll.trigger('click')
        await flushPromises()
        expect(vi.mocked(client.dismissAllNotifications)).toHaveBeenCalledOnce()
        expect(useNotificationStore().unreadCount).toBe(0)
    })

    it('opens the item when a notification is clicked, dismissing it', async () => {
        const item = makeNotification({feed_item_guid: 'item-guid-7'})
        stubClient('dismissNotification', ok(undefined))
        const {wrapper, router} = await mountBell({items: [item], unreadCount: 1})
        await wrapper.find('.bell-trigger').trigger('click')

        await wrapper.find('.bell-item-body').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.dismissNotification)).toHaveBeenCalledExactlyOnceWith(item.id)
        expect(router.currentRoute.value.name).toBe('item')
        expect(router.currentRoute.value.params.guid).toBe('item-guid-7')
        expect(wrapper.find('.bell-dropdown').exists()).toBe(false)   // closed
    })
})

describe('push CTA', () => {
    it('is hidden when the browser does not support push', async () => {
        const {wrapper} = await mountBell()
        await wrapper.find('.bell-trigger').trigger('click')
        expect(wrapper.find('.bell-push-cta').exists()).toBe(false)
    })

    it('enables push notifications from the CTA', async () => {
        stubBrowserPush()
        stubClient('getVapidPublicKey', ok('AQID'))
        stubClient('registerPushSubscription', ok(undefined, 201))
        const {wrapper} = await mountBell()
        await wrapper.find('.bell-trigger').trigger('click')

        const cta = wrapper.find('.bell-push-cta')
        expect(cta.text()).toContain('Push notifications')
        await cta.find('button').trigger('click')
        await flushPromises()

        expect(vi.mocked(client.registerPushSubscription)).toHaveBeenCalledOnce()
        expect(wrapper.find('.bell-push-cta').exists()).toBe(false)
        expect(wrapper.find('.bell-push-status').text()).toContain('Push notifications enabled on this device.')
    })

    it('sends a test notification from the subscribed state', async () => {
        stubBrowserPush({subscription: makeSubscription('https://push.example/e9')})
        stubClient('sendTestPushNotification', ok(undefined, 202))
        const {wrapper} = await mountBell()
        await wrapper.find('.bell-trigger').trigger('click')

        await wrapper.findAll('button').find(b => b.text() === 'Send test')!.trigger('click')
        await flushPromises()
        expect(vi.mocked(client.sendTestPushNotification)).toHaveBeenCalledExactlyOnceWith('https://push.example/e9')
        expect(wrapper.find('.bell-push-status').text()).toContain('Test notification sent')
    })

    it('disables push notifications again', async () => {
        stubBrowserPush({subscription: makeSubscription('https://push.example/e9')})
        stubClient('unregisterPushSubscription', ok(undefined))
        const {wrapper} = await mountBell()
        await wrapper.find('.bell-trigger').trigger('click')

        await wrapper.findAll('button').find(b => b.text() === 'Disable')!.trigger('click')
        await flushPromises()
        expect(vi.mocked(client.unregisterPushSubscription)).toHaveBeenCalledExactlyOnceWith('https://push.example/e9')
        expect(wrapper.find('.bell-push-cta').exists()).toBe(true)   // back to the CTA
    })
})
