<script setup lang="ts">
import {computed, onMounted, ref} from 'vue'
import {useRouter} from 'vue-router'
import {useDocumentVisibility, useIntervalFn, onClickOutside} from '@vueuse/core'
import {useNotificationStore} from '../stores/notifications.ts'
import {usePushSubscription} from '../composables/usePushSubscription.ts'
import client from '../client.ts'

const router = useRouter()
const notificationStore = useNotificationStore()
const visibility = useDocumentVisibility()
const {isSupported, isSubscribed, isBusy, permission, lastError, subscribe, unsubscribe} = usePushSubscription()

const isTesting = ref(false)
const testStatus = ref<{kind: 'success' | 'error', message: string} | null>(null)

const open = ref(false)
const rootEl = ref<HTMLElement>()

onClickOutside(rootEl, () => { open.value = false })

const unreadCount = computed(() => notificationStore.unreadCount)
const items = computed(() => notificationStore.items)
const hasItems = computed(() => items.value.length > 0)
const badgeLabel = computed(() => unreadCount.value > 9 ? '9+' : String(unreadCount.value))

const showPushCta = computed(() =>
    isSupported.value && permission.value !== 'denied' && !isSubscribed.value
)

onMounted(() => notificationStore.load())

useIntervalFn(() => {
    if (visibility.value === 'visible') void notificationStore.load()
}, 60_000)

function toggle() {
    open.value = !open.value
    if (open.value) void notificationStore.load()
}

function notificationLabel(feedTitle: string | null, feedAlias: string | null) {
    return feedAlias || feedTitle || 'A feed'
}

function openItem(feedItemGuid: string, id: number) {
    open.value = false
    void notificationStore.dismiss(id)
    void router.push({name: 'item', params: {guid: feedItemGuid}})
}

function formatTime(value: string) {
    const date = new Date(value)
    return date.toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})
}

async function handlePushToggle() {
    if (isSubscribed.value) {
        await unsubscribe()
    } else {
        await subscribe()
    }
}

let testStatusTimer: ReturnType<typeof setTimeout> | null = null

function setTestStatus(value: {kind: 'success' | 'error', message: string} | null) {
    if (testStatusTimer !== null) {
        clearTimeout(testStatusTimer)
        testStatusTimer = null
    }
    testStatus.value = value
    if (value) {
        testStatusTimer = setTimeout(() => {
            testStatus.value = null
            testStatusTimer = null
        }, 5000)
    }
}

async function handleSendTest() {
    if (isTesting.value) return
    isTesting.value = true
    setTestStatus(null)
    try {
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        if (!sub) {
            setTestStatus({kind: 'error', message: 'No active push subscription.'})
            return
        }
        const result = await client.sendTestPushNotification(sub.endpoint)
        setTestStatus(result.ok
            ? {kind: 'success', message: 'Test notification sent — check your device.'}
            : {kind: 'error', message: result.error})
    } finally {
        isTesting.value = false
    }
}
</script>

<template>
  <div ref="rootEl" class="notification-bell">
    <a
      role="button"
      class="navbar-item bell-trigger"
      :title="`${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`"
      @click="toggle"
    >
      <span class="icon">
        <span class="material-symbols-outlined">notifications</span>
      </span>
      <span v-if="unreadCount > 0" class="bell-badge">{{ badgeLabel }}</span>
    </a>

    <div v-if="open" class="bell-dropdown">
      <div class="bell-header">
        <strong>Notifications</strong>
        <button
          v-if="hasItems"
          class="button is-small is-text"
          :disabled="unreadCount === 0"
          @click="notificationStore.dismissAll()"
        >
          Mark all read
        </button>
      </div>

      <div v-if="showPushCta" class="bell-push-cta">
        <div>
          <strong>Push notifications</strong>
          <p class="is-size-7 has-text-grey">
            Get notified on this device when new {{ '' }}episodes or posts are published.
          </p>
          <p v-if="permission === 'denied'" class="is-size-7 has-text-danger">
            Notifications are blocked in your browser settings.
          </p>
          <p v-else-if="lastError" class="is-size-7 has-text-danger">
            {{ lastError }}
          </p>
        </div>
        <button
          class="button is-small is-info"
          :class="{'is-loading': isBusy}"
          :disabled="permission === 'denied'"
          @click="handlePushToggle"
        >
          Enable
        </button>
      </div>

      <div v-else-if="isSubscribed" class="bell-push-status">
        <div class="bell-push-status-body">
          <span class="is-size-7 has-text-grey">Push notifications enabled on this device.</span>
          <p v-if="lastError" class="is-size-7 has-text-danger">
            {{ lastError }}
          </p>
          <p
            v-if="testStatus"
            class="is-size-7"
            :class="testStatus.kind === 'success' ? 'has-text-success' : 'has-text-danger'"
          >
            {{ testStatus.message }}
          </p>
        </div>
        <div class="bell-push-status-actions">
          <button
            class="button is-small is-text"
            :class="{'is-loading': isTesting}"
            :disabled="isBusy"
            @click="handleSendTest"
          >
            Send test
          </button>
          <button
            class="button is-small is-text"
            :class="{'is-loading': isBusy}"
            :disabled="isTesting"
            @click="handlePushToggle"
          >
            Disable
          </button>
        </div>
      </div>

      <div v-if="!hasItems" class="bell-empty">
        You're all caught up.
      </div>
      <ul v-else class="bell-list">
        <li
          v-for="item in items"
          :key="item.id"
          class="bell-item"
          :class="{'is-dismissed': item.dismissed}"
        >
          <div class="bell-item-body" @click="openItem(item.feed_item_guid, item.id)">
            <div class="bell-item-title">
              {{ item.item_title || 'New item' }}
            </div>
            <div class="bell-item-meta">
              <span>{{ notificationLabel(item.feed_title, item.feed_alias) }}</span>
              <span v-if="item.type === 'updated_item'" class="tag is-warning is-light is-small">Updated</span>
              <span class="bell-item-time">{{ formatTime(item.created_at) }}</span>
            </div>
          </div>
          <button
            v-if="!item.dismissed"
            class="delete is-small"
            title="Dismiss"
            @click.stop="notificationStore.dismiss(item.id)"
          />
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.notification-bell {
    position: relative;
    display: flex;
    align-items: center;
}

.bell-trigger {
    position: relative;
    cursor: pointer;
}

.bell-badge {
    position: absolute;
    top: 0.4rem;
    right: 0.3rem;
    min-width: 1.1rem;
    height: 1.1rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    background: hsl(var(--bulma-danger-h), var(--bulma-danger-s), var(--bulma-danger-l));
    color: hsl(var(--bulma-danger-invert-h), var(--bulma-danger-invert-s), var(--bulma-danger-invert-l));
    font-size: 0.65rem;
    line-height: 1.1rem;
    font-weight: 600;
    text-align: center;
}

.bell-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    width: min(22rem, 90vw);
    max-height: 32rem;
    overflow-y: auto;
    background: hsl(var(--bulma-scheme-h), var(--bulma-scheme-s), var(--bulma-scheme-main-bis-l));
    color: hsl(var(--bulma-text-h), var(--bulma-text-s), var(--bulma-text-l));
    border: 1px solid hsl(var(--bulma-border-h), var(--bulma-border-s), var(--bulma-border-l));
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.2);
    z-index: 40;
}

.bell-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--bulma-border-weak);
}

.bell-push-cta,
.bell-push-status {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--bulma-border-weak);
}
.bell-push-cta > div,
.bell-push-status-body {
    flex: 1;
}
.bell-push-status-actions {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    align-items: stretch;
}

.bell-empty {
    padding: 1rem;
    color: hsl(var(--bulma-text-h), var(--bulma-text-s), 50%);
    text-align: center;
}

.bell-list {
    list-style: none;
    margin: 0;
    padding: 0;
}
.bell-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--bulma-border-weak);
}
.bell-item:last-child {
    border-bottom: none;
}
.bell-item.is-dismissed {
    opacity: 0.55;
}
.bell-item-body {
    flex: 1;
    cursor: pointer;
}
.bell-item-title {
    font-weight: 500;
    line-height: 1.3;
}
.bell-item-meta {
    margin-top: 0.2rem;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.75rem;
    color: hsl(var(--bulma-text-h), var(--bulma-text-s), 50%);
}
.bell-item-time {
    margin-left: auto;
}
</style>
