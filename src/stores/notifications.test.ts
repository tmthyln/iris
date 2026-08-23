import {createPinia, setActivePinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {err, makeNotification, ok, stubClient, stubClientPending} from '../testing/helpers.ts'
import {useNotificationStore} from './notifications.ts'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.restoreAllMocks())

describe('load', () => {
    it('stores items and the unread count', async () => {
        const items = [makeNotification(), makeNotification({dismissed: true})]
        stubClient('getNotifications', ok({items, unreadCount: 1}))
        const store = useNotificationStore()
        await store.load()
        expect(store.items).toEqual(items)
        expect(store.unreadCount).toBe(1)
        expect(store.loadState).toBe('loaded')
    })

    it('returns to unloaded on failure', async () => {
        stubClient('getNotifications', err())
        const store = useNotificationStore()
        await store.load()
        expect(store.loadState).toBe('unloaded')
    })

    it('does not start a second request while loading', async () => {
        const {spy, resolve} = stubClientPending('getNotifications')
        const store = useNotificationStore()
        const first = store.load()
        const second = store.load()
        resolve(ok({items: [], unreadCount: 0}))
        await Promise.all([first, second])
        expect(spy).toHaveBeenCalledOnce()
    })
})

describe('dismiss', () => {
    it('optimistically marks the notification read and decrements the badge', async () => {
        const target = makeNotification()
        const other = makeNotification()
        stubClient('dismissNotification', ok(undefined))
        const store = useNotificationStore()
        store.items = [target, other]
        store.unreadCount = 2

        expect(await store.dismiss(target.id)).toBe(true)
        expect(store.items.find(n => n.id === target.id)?.dismissed).toBe(true)
        expect(store.items.find(n => n.id === other.id)?.dismissed).toBe(false)
        expect(store.unreadCount).toBe(1)
    })

    it('does not decrement for an already-dismissed notification', async () => {
        const already = makeNotification({dismissed: true})
        stubClient('dismissNotification', ok(undefined))
        const store = useNotificationStore()
        store.items = [already]
        store.unreadCount = 3

        await store.dismiss(already.id)
        expect(store.unreadCount).toBe(3)
    })

    it('rolls back when the server rejects', async () => {
        const target = makeNotification()
        const store = useNotificationStore()
        store.items = [target]
        store.unreadCount = 1

        const {resolve} = stubClientPending('dismissNotification')
        const call = store.dismiss(target.id)
        expect(store.items[0].dismissed).toBe(true)
        expect(store.unreadCount).toBe(0)

        resolve(err())
        expect(await call).toBe(false)
        expect(store.items[0].dismissed).toBe(false)
        expect(store.unreadCount).toBe(1)
    })
})

describe('dismissAll', () => {
    it('marks everything read and zeroes the badge', async () => {
        stubClient('dismissAllNotifications', ok(undefined))
        const store = useNotificationStore()
        store.items = [makeNotification(), makeNotification()]
        store.unreadCount = 2

        expect(await store.dismissAll()).toBe(true)
        expect(store.items.every(n => n.dismissed)).toBe(true)
        expect(store.unreadCount).toBe(0)
    })

    it('rolls back when the server rejects', async () => {
        const items = [makeNotification(), makeNotification({dismissed: true})]
        const store = useNotificationStore()
        store.items = items
        store.unreadCount = 1

        const {resolve} = stubClientPending('dismissAllNotifications')
        const call = store.dismissAll()
        expect(store.unreadCount).toBe(0)
        resolve(err())
        expect(await call).toBe(false)
        expect(store.items.map(n => n.dismissed)).toEqual([false, true])
        expect(store.unreadCount).toBe(1)
    })
})
