import {defineStore} from "pinia";
import type {LoadingState, Notification} from "../types.ts";
import client from "../client.ts";

export const useNotificationStore = defineStore('notifications', {
    state: () => ({
        items: [] as Notification[],
        unreadCount: 0,
        loadState: 'unloaded' as LoadingState,
    }),
    actions: {
        async load() {
            if (this.loadState === 'loading') return
            this.loadState = 'loading'

            const result = await client.getNotifications()
            const data = result.ok ? result.data : null
            if (data) {
                this.items = data.items
                this.unreadCount = data.unreadCount
                this.loadState = 'loaded'
            } else {
                this.loadState = 'error'
            }
        },
        async dismiss(id: number) {
            const previous = this.items
            this.items = this.items.map(n => n.id === id ? {...n, dismissed: true} : n)
            const wasUnread = previous.find(n => n.id === id && !n.dismissed)
            if (wasUnread) this.unreadCount = Math.max(0, this.unreadCount - 1)

            const success = (await client.dismissNotification(id)).ok
            if (!success) {
                this.items = previous
                if (wasUnread) this.unreadCount += 1
            }
            return success
        },
        async dismissAll() {
            const previous = this.items
            const previousUnread = this.unreadCount
            this.items = this.items.map(n => ({...n, dismissed: true}))
            this.unreadCount = 0

            const success = (await client.dismissAllNotifications()).ok
            if (!success) {
                this.items = previous
                this.unreadCount = previousUnread
            }
            return success
        },
    },
})
