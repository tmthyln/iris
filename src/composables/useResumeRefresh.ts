import {watch} from 'vue'
import {useDocumentVisibility, useOnline} from '@vueuse/core'
import {useFeedItemStore} from '../stores/feeditems.ts'
import {useFeedStore} from '../stores/feeds.ts'
import {useQueueStore} from '../stores/queue.ts'

/** Reload data that is older than this when the app is resumed. */
const STALE_MS = 5 * 60_000

/**
 * An installed PWA is usually resumed, not relaunched: the page keeps running
 * in the background, so the on-mount loads ran long ago — and may have failed
 * outright (launched offline, flaky radio, request timeout, expired Cloudflare
 * Access session) or gone stale. Without this, a failed launch leaves the app
 * stuck on its empty states forever, since a standalone PWA has no
 * pull-to-refresh.
 *
 * Re-attempts failed loads and refreshes stale data whenever the app becomes
 * visible again or connectivity returns. If the Access session has expired,
 * the retried call 401s and client.ts navigates to re-authenticate, which
 * reloads the whole app.
 */
export function useResumeRefresh() {
    const feedStore = useFeedStore()
    const feedItemStore = useFeedItemStore()
    const queueStore = useQueueStore()

    function refresh() {
        void feedStore.refreshIfStale(STALE_MS)
        void feedItemStore.refreshRecentIfStale(STALE_MS)
        if (feedItemStore.bookmarkedLoadState === 'error') void feedItemStore.loadBookmarkedItems()
        // Don't touch a working queue — reloading replaces the items and could
        // disturb playback. Only recover from a failed load.
        if (queueStore.loadState === 'error') void queueStore.loadQueue()
    }

    const visibility = useDocumentVisibility()
    watch(visibility, (now, previous) => {
        if (now === 'visible' && previous === 'hidden') refresh()
    })

    const online = useOnline()
    watch(online, (now, previous) => {
        if (now && !previous) refresh()
    })

    return {refresh}
}
