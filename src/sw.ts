/// <reference lib="webworker" />
import {precacheAndRoute} from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)

interface PushPayload {
    type: 'new_item' | 'updated_item'
    feed_guid: string
    feed_item_guid: string
    title: string
    body: string
    url: string
}

self.addEventListener('push', (event) => {
    if (!event.data) return

    let payload: PushPayload
    try {
        payload = event.data.json() as PushPayload
    } catch {
        let body = 'New activity'
        try {
            body = event.data.text() || body
        } catch { /* binary or unreadable payload */ }
        payload = {
            type: 'new_item',
            feed_guid: '',
            feed_item_guid: '',
            title: 'Iris',
            body,
            url: '/',
        }
    }

    event.waitUntil(
        self.registration.showNotification(payload.title, {
            body: payload.body,
            icon: '/pwa-192x192.png',
            badge: '/pwa-64x64.png',
            tag: payload.feed_item_guid || undefined,
            data: {url: payload.url},
        }),
    )
})

interface PushSubscriptionChangeEventLike extends ExtendableEvent {
    oldSubscription: PushSubscription | null
    newSubscription: PushSubscription | null
}

function urlBase64ToUint8Array(base64String: string) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = atob(base64)
    const output = new Uint8Array(rawData.length)
    for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i)
    return output
}

async function resubscribePush(oldSubscription: PushSubscription | null) {
    let applicationServerKey: ArrayBuffer | Uint8Array | null =
        (oldSubscription?.options?.applicationServerKey as ArrayBuffer | null) ?? null

    if (!applicationServerKey) {
        const resp = await fetch('/api/push/vapid-public-key')
        if (!resp.ok) return
        const data = await resp.json().catch(() => null) as {key?: string} | null
        if (!data?.key) return
        applicationServerKey = urlBase64ToUint8Array(data.key)
    }

    const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
    })

    await fetch('/api/push/subscription', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(newSub.toJSON()),
    })

    if (oldSubscription?.endpoint && oldSubscription.endpoint !== newSub.endpoint) {
        await fetch('/api/push/subscription', {
            method: 'DELETE',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({endpoint: oldSubscription.endpoint}),
        }).catch(() => undefined)
    }
}

self.addEventListener('pushsubscriptionchange', (event) => {
    const evt = event as PushSubscriptionChangeEventLike
    evt.waitUntil(
        resubscribePush(evt.oldSubscription).catch(err =>
            console.error('pushsubscriptionchange: failed to re-subscribe', err),
        ),
    )
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const url = (event.notification.data?.url as string | undefined) ?? '/'

    event.waitUntil((async () => {
        const clientsList = await self.clients.matchAll({type: 'window', includeUncontrolled: true})
        for (const client of clientsList) {
            if ('focus' in client) {
                await client.focus()
                if ('navigate' in client) {
                    await client.navigate(url).catch(() => undefined)
                }
                return
            }
        }
        await self.clients.openWindow(url)
    })())
})
