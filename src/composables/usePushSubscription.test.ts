import {flushPromises, mount} from '@vue/test-utils'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import client from '../client.ts'
import {err, makeSubscription, ok, stubBrowserPush, stubClient} from '../testing/helpers.ts'
import {usePushSubscription} from './usePushSubscription.ts'

// 'AQID' is base64url for the bytes [1, 2, 3].
const VAPID_KEY = 'AQID'

/** The composable uses onMounted, so it must run inside a component. */
async function mountPush() {
    let push!: ReturnType<typeof usePushSubscription>
    mount(defineComponent({
        setup() {
            push = usePushSubscription()
            return () => h('div')
        },
    }))
    await flushPromises()
    return push
}

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'serviceWorker')
})

describe('support detection', () => {
    it('is unsupported in a browser without push APIs, and subscribe refuses', async () => {
        const push = await mountPush()
        expect(push.isSupported.value).toBe(false)
        expect(await push.subscribe()).toBe(false)
    })

    it('detects an existing subscription on mount', async () => {
        stubBrowserPush({subscription: makeSubscription()})
        const push = await mountPush()
        expect(push.isSupported.value).toBe(true)
        expect(push.isSubscribed.value).toBe(true)
    })
})

describe('subscribe', () => {
    it('subscribes with the server VAPID key and registers with the Worker', async () => {
        const pushManager = stubBrowserPush()
        stubClient('getVapidPublicKey', ok(VAPID_KEY))
        stubClient('registerPushSubscription', ok(undefined, 201))
        const push = await mountPush()

        expect(await push.subscribe()).toBe(true)
        expect(push.isSubscribed.value).toBe(true)
        expect(push.lastError.value).toBeNull()

        const options = pushManager.subscribe.mock.calls[0][0]!
        expect(options.userVisibleOnly).toBe(true)
        expect([...(options.applicationServerKey as Uint8Array)]).toEqual([1, 2, 3])
        expect(vi.mocked(client.registerPushSubscription)).toHaveBeenCalledExactlyOnceWith(
            {endpoint: 'https://push.example/endpoint-1', keys: {p256dh: 'p', auth: 'a'}})
    })

    it('reports blocked notifications without subscribing', async () => {
        const pushManager = stubBrowserPush()
        vi.mocked(Notification.requestPermission).mockResolvedValue('denied')
        const push = await mountPush()

        expect(await push.subscribe()).toBe(false)
        expect(push.permission.value).toBe('denied')
        expect(push.lastError.value).toMatch(/blocked/)
        expect(pushManager.subscribe).not.toHaveBeenCalled()
    })

    it('fails cleanly when the server has no VAPID key configured', async () => {
        stubBrowserPush()
        stubClient('getVapidPublicKey', err(500, 'no key'))
        const push = await mountPush()

        expect(await push.subscribe()).toBe(false)
        expect(push.lastError.value).toMatch(/not configured/)
    })

    it('rejects an invalid VAPID key before subscribing', async () => {
        const pushManager = stubBrowserPush()
        stubClient('getVapidPublicKey', ok('!!!not-base64!!!'))
        const push = await mountPush()

        expect(await push.subscribe()).toBe(false)
        expect(push.lastError.value).toMatch(/invalid VAPID key/)
        expect(pushManager.subscribe).not.toHaveBeenCalled()
    })

    it('rolls back the browser subscription when the Worker rejects it', async () => {
        const created = makeSubscription()
        const pushManager = stubBrowserPush()
        pushManager.subscribe.mockResolvedValue(created)
        stubClient('getVapidPublicKey', ok(VAPID_KEY))
        stubClient('registerPushSubscription', err(422, 'bad subscription'))
        const push = await mountPush()

        expect(await push.subscribe()).toBe(false)
        expect(created.unsubscribe).toHaveBeenCalledOnce()
        expect(push.lastError.value).toMatch(/rejected/)
        expect(push.isSubscribed.value).toBe(false)
    })
})

describe('unsubscribe', () => {
    it('removes the subscription locally and on the server', async () => {
        const sub = makeSubscription('https://push.example/endpoint-9')
        stubBrowserPush({subscription: sub})
        stubClient('unregisterPushSubscription', ok(undefined))
        const push = await mountPush()
        expect(push.isSubscribed.value).toBe(true)

        expect(await push.unsubscribe()).toBe(true)
        expect(sub.unsubscribe).toHaveBeenCalledOnce()
        expect(vi.mocked(client.unregisterPushSubscription))
            .toHaveBeenCalledExactlyOnceWith('https://push.example/endpoint-9')
        expect(push.isSubscribed.value).toBe(false)
    })

    it('still succeeds locally when the server cleanup fails (self-heals later)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const sub = makeSubscription()
        stubBrowserPush({subscription: sub})
        stubClient('unregisterPushSubscription', err())
        const push = await mountPush()

        expect(await push.unsubscribe()).toBe(true)
        expect(push.isSubscribed.value).toBe(false)
    })

    it('is a no-op success when there is nothing to unsubscribe', async () => {
        stubBrowserPush({subscription: null})
        const push = await mountPush()
        expect(await push.unsubscribe()).toBe(true)
        expect(push.isSubscribed.value).toBe(false)
    })
})
