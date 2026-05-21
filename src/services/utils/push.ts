import webpush, {WebPushError} from 'web-push'
import type {D1Database} from '@cloudflare/workers-types'
import {ServerPushSubscription} from '../models'
import {deletePushSubscription, getAllPushSubscriptions, touchPushSubscription} from '../crud'

export interface PushNotificationPayload {
    type: 'new_item' | 'updated_item'
    feed_guid: string
    feed_item_guid: string
    title: string
    body: string
    url: string
}

interface VapidEnv {
    VAPID_PUBLIC_KEY: string
    VAPID_PRIVATE_KEY: string
    VAPID_SUBJECT: string
    DB: D1Database
}

function getVapidDetails(env: VapidEnv) {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
        return null
    }
    return {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
    }
}

export async function sendWebPush(
    db: D1Database,
    vapid: {subject: string, publicKey: string, privateKey: string},
    sub: ServerPushSubscription,
    payload: PushNotificationPayload,
) {
    try {
        await webpush.sendNotification(
            {
                endpoint: sub.endpoint,
                keys: {p256dh: sub.p256dh, auth: sub.auth},
            },
            JSON.stringify(payload),
            {vapidDetails: vapid, TTL: 86400},
        )
        await touchPushSubscription(db, sub.endpoint)
    } catch (error) {
        if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
            await deletePushSubscription(db, sub.endpoint)
            return
        }
        console.error('Web push send failed', error)
    }
}

export interface PushFanOutContext {
    vapid: {subject: string, publicKey: string, privateKey: string}
    subscriptions: ServerPushSubscription[]
}

/**
 * Loads VAPID config and the current subscriber list once, so multiple
 * payloads in a refresh batch don't each re-query the subscription table.
 * Returns null if push is unconfigured or there are no subscribers.
 */
export async function loadPushFanOutContext(env: Env): Promise<PushFanOutContext | null> {
    const vapid = getVapidDetails(env as unknown as VapidEnv)
    if (!vapid) return null
    const subscriptions = await getAllPushSubscriptions(env.DB)
    if (subscriptions.length === 0) return null
    return {vapid, subscriptions}
}

export async function fanOutPushWithContext(
    db: D1Database,
    context: PushFanOutContext,
    payload: PushNotificationPayload,
) {
    await Promise.allSettled(
        context.subscriptions.map(sub => sendWebPush(db, context.vapid, sub, payload)),
    )
}

