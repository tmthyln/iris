import {env} from 'cloudflare:workers'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {WebPushError} from 'web-push'
import {ServerPushSubscription} from '../models'
import {resetStorage, stubWebPush, testEnv} from '../testing/fixtures'
import {fanOutPushWithContext, loadPushFanOutContext, sendWebPush, type PushNotificationPayload} from './push'

const db = env.DB

const vapid = {subject: 'mailto:test@example.com', publicKey: 'pub', privateKey: 'priv'}

const payload: PushNotificationPayload = {
    type: 'new_item',
    feed_guid: 'feed-a',
    feed_item_guid: 'item-a',
    title: 'Feed A',
    body: 'Item A',
    url: '/feeditem/item-a',
}

async function seedSubscription(endpoint: string) {
    const sub = new ServerPushSubscription({
        endpoint,
        p256dh: `p256dh-${endpoint}`,
        auth: `auth-${endpoint}`,
        created_at: '2024-01-01T00:00:00.000Z',
        last_used_at: null,
    })
    await sub.persistTo(db)
    return sub
}

async function subscriptionRows() {
    const {results} = await db.prepare('SELECT endpoint, last_used_at FROM push_subscription ORDER BY endpoint')
        .all<{endpoint: string, last_used_at: string | null}>()
    return results
}

function webPushError(statusCode: number) {
    return new WebPushError('push failed', statusCode, {}, '', 'https://push/1')
}

beforeEach(() => resetStorage())
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('sendWebPush', () => {
    test('sends the payload with the VAPID details and touches the subscription', async () => {
        const spy = stubWebPush()
        const sub = await seedSubscription('https://push/1')

        await sendWebPush(db, vapid, sub, payload)

        expect(spy).toHaveBeenCalledTimes(1)
        expect(spy).toHaveBeenCalledWith(
            {endpoint: 'https://push/1', keys: {p256dh: 'p256dh-https://push/1', auth: 'auth-https://push/1'}},
            JSON.stringify(payload),
            {vapidDetails: vapid, TTL: 86400},
        )
        const [row] = await subscriptionRows()
        expect(row.last_used_at).not.toBeNull()
    })

    test.each([404, 410])('deletes the subscription when the push service answers %i', async (statusCode) => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        stubWebPush(() => Promise.reject(webPushError(statusCode)))
        const sub = await seedSubscription('https://push/1')
        await seedSubscription('https://push/2')

        await sendWebPush(db, vapid, sub, payload)

        expect((await subscriptionRows()).map(r => r.endpoint)).toEqual(['https://push/2'])
        expect(error).not.toHaveBeenCalled()
    })

    test('logs other push service errors and keeps the subscription', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const failure = webPushError(500)
        stubWebPush(() => Promise.reject(failure))
        const sub = await seedSubscription('https://push/1')

        await sendWebPush(db, vapid, sub, payload)

        expect(error).toHaveBeenCalledWith('Web push send failed', failure)
        expect(await subscriptionRows()).toEqual([{endpoint: 'https://push/1', last_used_at: null}])
    })

    test('logs non-push errors and keeps the subscription', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const failure = new Error('network down')
        stubWebPush(() => Promise.reject(failure))
        const sub = await seedSubscription('https://push/1')

        await sendWebPush(db, vapid, sub, payload)

        expect(error).toHaveBeenCalledWith('Web push send failed', failure)
        expect(await subscriptionRows()).toEqual([{endpoint: 'https://push/1', last_used_at: null}])
    })
})

describe('loadPushFanOutContext', () => {
    test.each(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const)('returns null when %s is unset', async (name) => {
        await seedSubscription('https://push/1')
        const {env: testenv} = testEnv({[name]: ''})

        expect(await loadPushFanOutContext(testenv)).toBeNull()
    })

    test('returns null when there are no subscriptions', async () => {
        expect(await loadPushFanOutContext(testEnv().env)).toBeNull()
    })

    test('returns the VAPID details and every subscription', async () => {
        await seedSubscription('https://push/1')
        await seedSubscription('https://push/2')

        const context = await loadPushFanOutContext(testEnv().env)

        expect(context).not.toBeNull()
        expect(context!.vapid).toEqual({
            subject: 'mailto:test@example.com',
            publicKey: 'test-vapid-public-key',
            privateKey: 'test-vapid-private-key',
        })
        expect(context!.subscriptions).toHaveLength(2)
        expect(context!.subscriptions[0]).toBeInstanceOf(ServerPushSubscription)
        expect(context!.subscriptions.map(s => s.endpoint).sort()).toEqual(['https://push/1', 'https://push/2'])
    })
})

describe('fanOutPushWithContext', () => {
    test('sends the payload to every subscription', async () => {
        const spy = stubWebPush()
        const subscriptions = [await seedSubscription('https://push/1'), await seedSubscription('https://push/2')]

        await fanOutPushWithContext(db, {vapid, subscriptions}, payload)

        expect(spy).toHaveBeenCalledTimes(2)
        expect(spy.mock.calls.map(call => call[0].endpoint).sort()).toEqual(['https://push/1', 'https://push/2'])
        expect((await subscriptionRows()).every(r => r.last_used_at !== null)).toBe(true)
    })

    test('one failing send does not stop the others', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const spy = stubWebPush((subscription) => subscription.endpoint === 'https://push/1'
            ? Promise.reject(new Error('boom'))
            : Promise.resolve({statusCode: 201, body: '', headers: {}}))
        const subscriptions = [await seedSubscription('https://push/1'), await seedSubscription('https://push/2')]

        await expect(fanOutPushWithContext(db, {vapid, subscriptions}, payload)).resolves.toBeUndefined()

        expect(spy).toHaveBeenCalledTimes(2)
        expect(error).toHaveBeenCalledTimes(1)
        expect(await subscriptionRows()).toEqual([
            {endpoint: 'https://push/1', last_used_at: null},
            {endpoint: 'https://push/2', last_used_at: expect.any(String) as string},
        ])
    })
})
