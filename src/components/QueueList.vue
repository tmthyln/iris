<script setup lang="ts">
import {computed, ref} from "vue";
import {useSortable} from "@vueuse/integrations/useSortable";
import {useQueueStore} from "../stores/queue.ts";
import {useFeedStore} from "../stores/feeds.ts";
import type {FeedItemPreview} from "../types.ts";
import {useSwipeToDismiss} from "../swipe.ts";
import {unescapeHTML} from "../htmlproc.ts";

defineProps<{
    // Full-size touch targets, two-line titles and the show name, for the full screen player.
    roomy?: boolean,
}>()

const queueStore = useQueueStore()
const feedStore = useFeedStore()

const upcomingItems = computed(() => queueStore.upcoming)

const queueListEl = ref<HTMLElement>()
useSortable(queueListEl, upcomingItems, {
    watchElement: true, // required: queue list is inside a v-if and may not exist at mount time
    handle: '.drag-handle',
    animation: 150,
    delay: 100,
    delayOnTouchOnly: true,
    onUpdate() {}, // suppress default which tries to write to the readonly computed
    onEnd(event) {
        if (event.oldIndex != null && event.newIndex != null && event.oldIndex !== event.newIndex) {
            const item = upcomingItems.value[event.oldIndex]
            // offset by 1 since items[0] is the currently playing item
            void queueStore.moveItem(item, event.newIndex + 1)
        }
    },
})

function playNow(item: FeedItemPreview) {
    void queueStore.playItem(item)
}

function removeFromQueue(item: FeedItemPreview) {
    void queueStore.removeItem(item)
}

function clearQueue() {
    const keepFirst = !queueStore.paused
    void queueStore.clearQueue(keepFirst)
}

function feedTitle(item: FeedItemPreview) {
    const title = feedStore.getFeedById(item.source_feed)?.title
    return title ? unescapeHTML(title) : ''
}

const {onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, swipeStyle} = useSwipeToDismiss(removeFromQueue, {ignoreSelector: '.drag-handle'})
</script>

<template>
  <div class="queue" :class="{'is-roomy': roomy}">
    <div class="queue-header px-4 py-3 is-flex is-align-items-center is-justify-content-space-between">
      <strong>Up Next</strong>
      <button
        class="button is-small control-button"
        title="Clear queue"
        @click="clearQueue"
      >
        <span class="material-symbols-outlined is-size-6">playlist_remove</span>
      </button>
    </div>
    <div ref="queueListEl" class="queue-list">
      <div
        v-for="item in upcomingItems"
        :key="item.guid"
        class="queue-item is-flex is-align-items-center px-3 py-2 is-gap-2"
        :style="swipeStyle(item)"
        @touchstart="onTouchStart(item, $event)"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd(item)"
        @touchcancel="onTouchCancel"
      >
        <span class="material-symbols-outlined drag-handle has-text-grey" style="cursor: grab; touch-action: none;">
          drag_indicator
        </span>
        <div class="is-flex-grow-1 queue-item-text">
          <div class="queue-item-title" :class="{'is-size-7': !roomy}">
            {{ unescapeHTML(item.title) }}
          </div>
          <div v-if="roomy" class="queue-item-feed is-size-7">
            {{ feedTitle(item) }}
          </div>
        </div>
        <button
          class="button is-small px-1 control-button"
          title="Play now"
          @click="playNow(item)"
        >
          <span class="material-symbols-outlined is-size-6">play_arrow</span>
        </button>
        <button
          class="button is-small px-1 control-button"
          :class="{'is-hidden-mobile': !roomy}"
          title="Remove from queue"
          @click="removeFromQueue(item)"
        >
          <span class="material-symbols-outlined is-size-6">close</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.control-button {
    border: none;
}

.queue-header {
    border-bottom: 1px solid var(--bulma-border);
}

.queue-item {
    border-bottom: 1px solid var(--bulma-border-weak);
    touch-action: pan-y;
    transition: transform 0.2s, opacity 0.2s;

    &:last-child {
        border-bottom: none;
    }

    &:hover {
        background-color: var(--bulma-background);
    }
}

.queue-item-text {
    min-width: 0;
}

.queue-item-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.is-roomy {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;

    .queue-header {
        flex: none;
        min-height: 3.5rem;
    }

    .queue-list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
    }

    .queue-item:hover {
        background-color: transparent;
    }

    .queue-item-title {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        white-space: normal;
    }

    .queue-item-feed {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .button {
        flex: none;
        width: 2.75rem;
        height: 2.75rem;
        background: transparent;

        .material-symbols-outlined {
            font-size: 1.5rem !important;
        }
    }

    .drag-handle {
        flex: none;
        padding: 0.625rem 0.25rem;
    }
}
</style>
