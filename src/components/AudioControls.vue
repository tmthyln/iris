<script setup lang="ts">
import {FeedItemPreview} from "../types.ts";
import {computed, ref, watch} from "vue";
import {useElementHover} from "@vueuse/core";
import {useQueueStore} from "../stores/queue.ts";
import {useFeedItemStore} from "../stores/feeditems.ts";
import {useFeedStore} from "../stores/feeds.ts";
import {useDownloadStore} from "../stores/downloads.ts";
import {useTranscriptStore} from "../stores/transcripts.ts";

const props = defineProps<{
    feedItem: FeedItemPreview,
    // Fetching transcript state costs a request per item, and opening the
    // transcript needs ItemView's TranscriptView — so only ItemView opts in.
    showTranscript?: boolean,
}>()

const feedItemStore = useFeedItemStore()
const feedStore = useFeedStore()
const downloadStore = useDownloadStore()

// Computed so it tracks navigation between items and the feeds list
// finishing its initial load, rather than snapshotting at setup time.
const feed = computed(() => feedStore.getFeedById(props.feedItem.source_feed))

/* Queuing and Playing */
const queueStore = useQueueStore()

const playingStatus = computed(() => {
    if (queueStore.itemPlaying(props.feedItem)) {
        return queueStore.paused ? 'paused' : 'playing';
    } else if (queueStore.itemQueued(props.feedItem)) {
        return 'queued'
    } else if (!props.feedItem.finished) {
        return 'playable'
    } else {
        return 'replayable'
    }
})
const playingStatusString = computed(() => {
    switch (playingStatus.value) {
        case 'playing': return 'Playing'
        case 'paused': return 'Paused'
        case 'queued': return 'Queued'
        case 'playable': return 'Play'
        case 'replayable': return 'Play Again'
        default: return 'Unknown'
    }
})

const toggleQueuedButton = ref<HTMLButtonElement>()
const isHoveredQueuedButton = useElementHover(toggleQueuedButton)

function playItem() {
    if (playingStatus.value === 'playing' || playingStatus.value === 'paused') {
        queueStore.togglePaused()
    } else if (playingStatus.value === 'playable' || playingStatus.value === 'replayable' || playingStatus.value === 'queued') {
        void queueStore.playItem(props.feedItem)
    }
}

function toggleQueue() {
    if (queueStore.itemQueuedOrPlaying(props.feedItem)) {
        void queueStore.removeItem(props.feedItem)
    } else {
        void queueStore.addItem(props.feedItem)
    }
}

/* Completion */
const toggleFinishedButton = ref<HTMLButtonElement>()
const isHoveredFinishedButton = useElementHover(toggleFinishedButton)

function toggleFinished() {
    if (props.feedItem.finished) {
        void feedItemStore.markItemAsIncomplete(props.feedItem)
    } else {
        void feedItemStore.markItemAsComplete(props.feedItem)
    }
}

/* Bookmarking */
const toggleBookmarkButton = ref<HTMLButtonElement>()
const isHoveredBookmarkButton = useElementHover(toggleBookmarkButton)

function toggleBookmark() {
    if (props.feedItem.bookmarked) {
        void feedItemStore.unbookmarkItem(props.feedItem)
    } else {
        void feedItemStore.bookmarkItem(props.feedItem)
    }
}

/* Downloading */
const toggleDownloadButton = ref<HTMLButtonElement>()
const isHoveredDownloadButton = useElementHover(toggleDownloadButton)

const downloadStatus = computed(() => downloadStore.getStatus(props.feedItem.guid))

const downloadProgress = computed(() => {
    const s = downloadStatus.value
    return typeof s === 'object' && s.state === 'downloading'
        ? Math.round(s.progress * 100)
        : 0
})

function toggleDownload() {
    const s = downloadStatus.value
    if (typeof s === 'object' && s.state === 'downloading') {
        downloadStore.cancelDownload(props.feedItem.guid)
    } else if (typeof s === 'object' && s.state === 'downloaded') {
        void downloadStore.deleteDownload(props.feedItem.guid)
    } else {
        void downloadStore.downloadItem(props.feedItem)
    }
}

/* Transcript */
const transcriptStore = useTranscriptStore()
const toggleTranscriptButton = ref<HTMLButtonElement>()
const isHoveredTranscriptButton = useElementHover(toggleTranscriptButton)

const emit = defineEmits<{
    'open-transcript': []
}>()

const transcripts = computed(() => transcriptStore.getForItem(props.feedItem.guid))
const latestTranscript = computed(() => transcriptStore.latest(props.feedItem.guid))
const transcriptStatus = computed<'none' | 'in-progress' | 'complete' | 'error'>(() => {
    const list = transcripts.value
    if (list.some(t => t.status === 'pending' || t.status === 'processing')) return 'in-progress'
    if (list.some(t => t.status === 'complete')) return 'complete'
    if (list.length > 0 && list[0].status === 'error') return 'error'
    return 'none'
})

watch([() => props.feedItem.guid, feed], ([guid, currentFeed]) => {
    if (props.showTranscript && currentFeed?.type === 'podcast' && props.feedItem.enclosure_url) {
        void transcriptStore.refresh(guid)
    }
}, {immediate: true})

function onTranscriptClick() {
    const status = transcriptStatus.value
    if (status === 'none') {
        void transcriptStore.request(props.feedItem.guid)
    } else if (status === 'error') {
        void transcriptStore.request(props.feedItem.guid)
    } else if (status === 'complete') {
        emit('open-transcript')
    }
}
</script>

<template>
  <div class="is-flex is-align-items-center mb-3 is-gap-1">
    <button
      v-if="feed?.type === 'podcast'"
      class="button tag px-3 is-rounded is-medium is-gap-1"
      :class="{'has-text-info': true, 'has-text-success': false}"
      @click="playItem"
    >
      <span
        v-if="!feedItem.finished && !queueStore.itemQueuedOrPlaying(feedItem)"
        class="material-symbols-outlined"
      >
        play_arrow
      </span>
      <span
        v-else-if="queueStore.itemPlaying(feedItem)"
        class="material-symbols-outlined"
      >
        play_circle
      </span>
      <span
        v-else
        class="material-symbols-outlined"
      >
        replay
      </span>

      {{ playingStatusString }}
    </button>

    <button
      v-if="feed?.type === 'podcast'"
      ref="toggleQueuedButton"
      class="button is-small px-0 py-1"
      style="border: none;"
      @click="toggleQueue"
    >
      <span
        v-if="isHoveredQueuedButton && queueStore.itemQueued(feedItem)"
        class="material-symbols-outlined has-text-warning"
        title="Remove this item from the queue"
      >
        playlist_remove
      </span>
      <span
        v-else-if="queueStore.itemQueued(feedItem)"
        class="material-symbols-outlined has-text-success"
      >
        playlist_add_check
      </span>
      <span
        v-else
        class="material-symbols-outlined"
        :class="{'has-text-success': isHoveredQueuedButton}"
        title="Add this item to the end of the queue"
      >
        playlist_add
      </span>
    </button>

    <button
      ref="toggleFinishedButton"
      class="button is-small px-0 py-1"
      style="border: none;"
      @click="toggleFinished"
    >
      <span
        v-if="isHoveredFinishedButton && feedItem.finished"
        class="material-symbols-outlined has-text-warning"
        title="Mark item as not completed"
      >
        remove_done
      </span>
      <span
        v-else-if="feedItem.finished"
        class="material-symbols-outlined has-text-success"
      >
        check_circle
      </span>
      <span
        v-else
        class="material-symbols-outlined"
        :class="{'has-text-success': isHoveredFinishedButton}"
        title="Mark this item as complete"
      >
        done
      </span>
    </button>

    <button
      ref="toggleBookmarkButton"
      class="button is-small px-0 py-1"
      style="border: none;"
      @click="toggleBookmark"
    >
      <span
        v-if="isHoveredBookmarkButton && feedItem.bookmarked"
        class="material-symbols-outlined has-text-warning"
        title="Unbookmark this item"
      >
        bookmark_remove
      </span>
      <span
        v-else-if="feedItem.bookmarked"
        class="material-symbols-outlined has-text-success"
      >
        bookmark_added
      </span>
      <span
        v-else
        class="material-symbols-outlined"
        :class="{'has-text-success': isHoveredBookmarkButton}"
        title="Bookmark this item"
      >
        bookmark_add
      </span>
    </button>

    <button
      v-if="feed?.type === 'podcast' && feedItem.enclosure_url"
      ref="toggleDownloadButton"
      class="button is-small px-0 py-1"
      style="border: none;"
      @click="toggleDownload"
    >
      <span
        v-if="typeof downloadStatus === 'object' && downloadStatus.state === 'downloading'"
        class="material-symbols-outlined has-text-info download-pulse"
        :title="`Downloading: ${downloadProgress}%`"
      >
        downloading
      </span>
      <span
        v-else-if="typeof downloadStatus === 'object' && downloadStatus.state === 'error'"
        class="material-symbols-outlined has-text-danger"
        :title="`Download failed: ${downloadStatus.message}. Click to retry`"
      >
        error
      </span>
      <span
        v-else-if="isHoveredDownloadButton && typeof downloadStatus === 'object' && downloadStatus.state === 'downloaded'"
        class="material-symbols-outlined has-text-warning"
        title="Remove downloaded audio"
      >
        download_done
      </span>
      <span
        v-else-if="typeof downloadStatus === 'object' && downloadStatus.state === 'downloaded'"
        class="material-symbols-outlined has-text-success"
      >
        download_done
      </span>
      <span
        v-else
        class="material-symbols-outlined"
        :class="{'has-text-success': isHoveredDownloadButton}"
        title="Download for offline playback"
      >
        download
      </span>
    </button>

    <button
      v-if="showTranscript && feed?.type === 'podcast' && feedItem.enclosure_url"
      ref="toggleTranscriptButton"
      class="button is-small px-0 py-1"
      style="border: none;"
      @click="onTranscriptClick"
    >
      <span
        v-if="transcriptStatus === 'in-progress'"
        class="material-symbols-outlined has-text-info download-pulse"
        title="Transcribing audio…"
      >
        graphic_eq
      </span>
      <span
        v-else-if="transcriptStatus === 'error'"
        class="material-symbols-outlined has-text-danger"
        :title="`Transcription failed: ${latestTranscript?.error_message ?? 'unknown error'}. Click to retry`"
      >
        error
      </span>
      <span
        v-else-if="transcriptStatus === 'complete'"
        class="material-symbols-outlined"
        :class="{'has-text-success': !isHoveredTranscriptButton, 'has-text-info': isHoveredTranscriptButton}"
        title="View transcript"
      >
        description
      </span>
      <span
        v-else
        class="material-symbols-outlined"
        :class="{'has-text-success': isHoveredTranscriptButton}"
        title="Generate transcript"
      >
        description
      </span>
    </button>
  </div>
</template>

<style scoped>
.download-pulse {
    animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}
</style>