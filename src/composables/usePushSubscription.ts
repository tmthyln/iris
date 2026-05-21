import {ref, computed, onMounted} from 'vue'
import client from '../client.ts'

function urlBase64ToUint8Array(base64String: string) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = atob(base64)
    const output = new Uint8Array(rawData.length)
    for (let i = 0; i < rawData.length; i++) {
        output[i] = rawData.charCodeAt(i)
    }
    return output
}

async function getRegistration() {
    if (!('serviceWorker' in navigator)) return null
    // Surface a clear error if no SW ever registers (e.g. dev build without PWA
    // dev options) instead of hanging here forever.
    return Promise.race([
        navigator.serviceWorker.ready,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Service worker did not register')), 5000),
        ),
    ])
}

export function usePushSubscription() {
    const isSupported = computed(() =>
        typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window
    )
    const isSubscribed = ref(false)
    const isBusy = ref(false)
    const permission = ref<NotificationPermission>(
        typeof Notification !== 'undefined' ? Notification.permission : 'default'
    )
    const lastError = ref<string | null>(null)

    async function refreshSubscriptionState() {
        if (!isSupported.value) return
        try {
            const reg = await getRegistration()
            const sub = await reg?.pushManager.getSubscription()
            isSubscribed.value = !!sub
            if (typeof Notification !== 'undefined') {
                permission.value = Notification.permission
            }
        } catch (err) {
            console.error('Failed to refresh push subscription state', err)
        }
    }

    onMounted(refreshSubscriptionState)

    async function subscribe() {
        if (!isSupported.value || isBusy.value) return false
        isBusy.value = true
        lastError.value = null
        try {
            const result = await Notification.requestPermission()
            permission.value = result
            if (result !== 'granted') {
                lastError.value = result === 'denied'
                    ? 'Notifications are blocked. Allow them in your browser settings.'
                    : 'Notification permission was not granted.'
                return false
            }

            const reg = await getRegistration()
            if (!reg) {
                lastError.value = 'Service worker is not ready.'
                return false
            }

            const publicKey = await client.getVapidPublicKey()
            if (!publicKey) {
                lastError.value = 'Push notifications are not configured on the server.'
                return false
            }

            let applicationServerKey: Uint8Array
            try {
                applicationServerKey = urlBase64ToUint8Array(publicKey)
            } catch {
                lastError.value = 'Server returned an invalid VAPID key.'
                return false
            }

            const subscription = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey,
            })

            const ok = await client.registerPushSubscription(subscription.toJSON())
            if (!ok) {
                await subscription.unsubscribe().catch(() => undefined)
                lastError.value = 'Server rejected the subscription.'
                return false
            }

            isSubscribed.value = true
            return true
        } catch (err) {
            console.error('Push subscribe failed', err)
            lastError.value = err instanceof Error ? err.message : 'Failed to enable push notifications.'
            return false
        } finally {
            isBusy.value = false
        }
    }

    async function unsubscribe() {
        if (!isSupported.value || isBusy.value) return false
        isBusy.value = true
        lastError.value = null
        try {
            const reg = await getRegistration()
            const sub = await reg?.pushManager.getSubscription()
            if (!sub) {
                isSubscribed.value = false
                return true
            }
            const endpoint = sub.endpoint
            const removedLocally = await sub.unsubscribe()
            const serverOk = await client.unregisterPushSubscription(endpoint)
            if (!serverOk) {
                // Browser-side removal succeeded; server cleanup will happen
                // on the next push attempt via the 410/404 path. Don't block
                // the user — just record it.
                console.warn('Failed to remove push subscription on server; will self-heal')
            }
            isSubscribed.value = !removedLocally
            return removedLocally
        } catch (err) {
            console.error('Push unsubscribe failed', err)
            lastError.value = err instanceof Error ? err.message : 'Failed to disable push notifications.'
            return false
        } finally {
            isBusy.value = false
        }
    }

    return {
        isSupported,
        isSubscribed,
        isBusy,
        permission,
        lastError,
        subscribe,
        unsubscribe,
        refreshSubscriptionState,
    }
}
