<script setup lang="ts">
import {FeedItemPreview} from "../types.ts";
import {computed, ref} from "vue";
import {useElementHover} from "@vueuse/core";
import {useQueueStore} from "../stores/queue.ts";
import {useFeedItemStore} from "../stores/feeditems.ts";
import {useFeedStore} from "../stores/feeds.ts";

const props = defineProps<{
    feedItem: FeedItemPreview,
}>()

const feedItemStore = useFeedItemStore()
const feedStore = useFeedStore()

const feed = feedStore.getFeedById(props.feedItem.source_feed)

/* Queuing and Playing */
const queueStore = useQueueStore()

const playingStatus = computed(() => {
    if (queueStore.itemIsPlaying(props.feedItem)) {
        return 'playing'
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
        case 'queued': return 'In the Queue'
        case 'playable': return 'Play'
        case 'replayable': return 'Play Again'
    }
})

const toggleQueuedButton = ref<HTMLButtonElement>()
const isHoveredQueuedButton = useElementHover(toggleQueuedButton)

function toggleQueue() {
    if (queueStore.itemQueuedOrPlaying(props.feedItem)) {
        // TODO remove from queue
    } else {
        // TODO add to queue
    }
}

/* Completion */
const toggleFinishedButton = ref<HTMLButtonElement>()
const isHoveredFinishedButton = useElementHover(toggleFinishedButton)

function toggleFinished() {
    if (props.feedItem.finished) {
        feedItemStore.markItemAsIncomplete(props.feedItem)
    } else {
        feedItemStore.markItemAsComplete(props.feedItem)
    }
}

/* Bookmarking */
const toggleBookmarkButton = ref<HTMLButtonElement>()
const isHoveredBookmarkButton = useElementHover(toggleBookmarkButton)

function toggleBookmark() {
    if (props.feedItem.bookmarked) {
        feedItemStore.unbookmarkItem(props.feedItem)
    } else {
        feedItemStore.bookmarkItem(props.feedItem)
    }
}
</script>

<template>
  <div class="is-flex is-align-items-center mb-3 is-gap-1">
    <div
        v-if="feed.type === 'podcast'"
        class="button tag px-3 is-rounded is-medium is-gap-1"
        :class="{'has-text-info': true, 'has-text-success': false}">

      <span
          v-if="!feedItem.finished && !queueStore.itemQueuedOrPlaying(feedItem)"
          class="material-symbols-outlined">
        play_arrow
      </span>
      <span
          v-else-if="queueStore.itemIsPlaying(feedItem)"
          class="material-symbols-outlined">
        play_circle
      </span>
      <span
          v-else
          class="material-symbols-outlined">
        replay
      </span>

      {{ playingStatusString }}
    </div>

    <button
        v-if="feed.type === 'podcast'"
        ref="toggleQueuedButton"
        class="button is-small px-0 py-1" style="border: none;"
        @click="toggleQueue">
      <span
          v-if="isHoveredQueuedButton && queueStore.itemQueued(feedItem)"
          class="material-symbols-outlined has-text-warning"
          title="Remove this item from the queue">
        playlist_remove
      </span>
      <span
          v-else-if="queueStore.itemQueued(feedItem)"
          class="material-symbols-outlined has-text-success">
        playlist_add_check
      </span>
      <span
          v-else
          class="material-symbols-outlined"
          title="Add this item to the end of the queue">
        playlist_add
      </span>
    </button>

    <button
        ref="toggleFinishedButton"
        class="button is-small px-0 py-1" style="border: none;"
        @click="toggleFinished">
      <span
          v-if="isHoveredFinishedButton && feedItem.finished"
          class="material-symbols-outlined has-text-warning"
          title="Mark item as not completed">
        remove_done
      </span>
      <span
          v-else-if="feedItem.finished"
          class="material-symbols-outlined has-text-success">
        check_circle
      </span>
      <span
          v-else
          class="material-symbols-outlined"
          title="Mark this item as complete">
        done
      </span>
    </button>

    <button
        ref="toggleBookmarkButton"
        class="button is-small px-0 py-1" style="border: none;"
        @click="toggleBookmark">
      <span
          v-if="isHoveredBookmarkButton && feedItem.bookmarked"
          class="material-symbols-outlined has-text-warning"
          title="Unbookmark this item">
        bookmark_remove
      </span>
      <span
          v-else-if="feedItem.bookmarked"
          class="material-symbols-outlined has-text-success">
        bookmark_added
      </span>
      <span
          v-else
          class="material-symbols-outlined"
          title="Bookmark this item">
        bookmark_add
      </span>
    </button>
  </div>
</template>

<style scoped>

</style>