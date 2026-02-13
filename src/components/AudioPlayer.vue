<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {useIntervalFn, useMediaControls, onClickOutside} from "@vueuse/core";
import {useSortable} from "@vueuse/integrations/useSortable";
import {useDurationFormat} from "../format.ts";
import {useQueueStore} from "../stores/queue.ts";
import {useFeedItemStore} from "../stores/feeditems.ts";
import {useFeedStore} from "../stores/feeds.ts";
import type {FeedItemPreview} from "../types.ts";

const queueStore = useQueueStore()
const feedItemStore = useFeedItemStore()
const feedStore = useFeedStore()

const currentItem = computed(() => queueStore.currentlyPlaying)
const upcomingItems = computed(() => queueStore.items.slice(1))

const src = computed(() => currentItem.value?.enclosure_url ?? '')

const audio = ref<HTMLAudioElement>()
const {
    playing,
    rate,
    currentTime,
    duration,
    ended,
} = useMediaControls(audio, {
    src,
})

const autoPlayNext = ref(false)

watch(duration, (newDuration) => {
    if (newDuration > 0 && currentItem.value) {
        if (currentItem.value.progress > 0 && currentItem.value.progress < 1) {
            currentTime.value = currentItem.value.progress * newDuration
        }
        if (autoPlayNext.value) {
            playing.value = true
            autoPlayNext.value = false
        }
    }
})

watch(() => queueStore.paused, (paused) => {
    playing.value = !paused
})
watch(playing, (isPlaying) => {
    queueStore.paused = !isPlaying
    if (!isPlaying && currentItem.value && duration.value > 0) {
        feedItemStore.updateItemProgress(currentItem.value, currentTime.value / duration.value)
    }
})

function setPlaybackPosition(event: Event) {
    const target = event.currentTarget as HTMLInputElement
    currentTime.value = Number(target.value)
    if (currentItem.value && duration.value > 0) {
        feedItemStore.updateItemProgress(currentItem.value, currentTime.value / duration.value)
    }
}
function fastRewind() {
    currentTime.value = Math.max(0, currentTime.value - 10)
}
function fastForward() {
    currentTime.value = Math.min(duration.value, currentTime.value + 30)
}
async function skipNext() {
    if (!currentItem.value || upcomingItems.value.length === 0) return
    autoPlayNext.value = playing.value
    if (duration.value > 0) {
        await feedItemStore.updateItemProgress(currentItem.value, currentTime.value / duration.value)
    }
    await queueStore.removeItem(currentItem.value)
}

const playbackRates = [1, 1.25, 1.5, 1.75, 2, 0.25, 0.5]
function cyclePlaybackRate() {
    const currentIndex = playbackRates.indexOf(rate.value)
    const nextIndex = (currentIndex + 1) % playbackRates.length
    rate.value = playbackRates[nextIndex]
}

useIntervalFn(() => {
    if (playing.value && currentItem.value && duration.value > 0) {
        feedItemStore.updateItemProgress(currentItem.value, currentTime.value / duration.value)
    }
}, 5000)
watch(ended, async () => {
    if (ended.value && currentItem.value) {
        await feedItemStore.updateItemProgress(currentItem.value, 1)
        if (upcomingItems.value.length > 0) {
            autoPlayNext.value = true
            await queueStore.removeItem(currentItem.value)
        }
    }
})

/* Media Session */
watch(currentItem, (item) => {
    if (!('mediaSession' in navigator)) return
    if (!item) {
        navigator.mediaSession.metadata = null
        return
    }
    const feed = feedStore.getFeedById(item.source_feed)
    navigator.mediaSession.metadata = new MediaMetadata({
        title: item.title,
        artist: feed?.author,
        album: feed?.title,
        artwork: feed?.image_src ? [{src: feed.image_src}] : [],
    })
}, {immediate: true})

if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => { playing.value = true })
    navigator.mediaSession.setActionHandler('pause', () => { playing.value = false })
    navigator.mediaSession.setActionHandler('seekbackward', () => fastRewind())
    navigator.mediaSession.setActionHandler('seekforward', () => fastForward())
    navigator.mediaSession.setActionHandler('nexttrack', () => skipNext())
}

/* Queue popover */
const showQueue = ref(false)
const queuePopover = ref<HTMLElement>()

onClickOutside(queuePopover, () => {
    showQueue.value = false
}, {ignore: ['.queue-toggle-button']})

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
            queueStore.moveItem(item, event.newIndex + 1)
        }
    },
})

function playNow(item: FeedItemPreview) {
    queueStore.playItem(item)
}

function removeFromQueue(item: FeedItemPreview) {
    queueStore.removeItem(item)
}

function clearQueue() {
    const keepFirst = !queueStore.paused
    queueStore.clearQueue(keepFirst)
}
</script>

<template>
  <template v-if="queueStore.items.length">
    <div class="footer-placeholder"/>
    <footer class="audio-player-section has-background is-flex is-flex-direction-column is-align-items-stretch is-justify-content-space-between">
      <input
          class="playback-progress p-0 m-0"
          type="range"
          :min="0" :max="duration"
          :value="currentTime" @input="setPlaybackPosition"
          :style="{background: `linear-gradient(to right, #aced32 ${Math.floor(100*currentTime/duration)}%, #ccc ${Math.floor(100*currentTime/duration)}%)`}">
      <div class="player-layout p-4 is-flex-grow-1">
        <audio ref="audio"></audio>

        <div class="player-left">
          {{ currentItem?.title }}
        </div>
        <div class="player-center">

          <button class="tag button" @click="cyclePlaybackRate">
            {{ rate }}x
          </button>

          <button class="button is-rounded px-2 control-button" title="Rewind 10 seconds" @click="fastRewind">
            <span class="material-symbols-outlined">fast_rewind</span>
          </button>

          <button class="button is-rounded px-3 is-large control-button" @click="playing = !playing">
            <span v-if="!playing" class="material-symbols-outlined">play_arrow</span>
            <span v-else class="material-symbols-outlined">pause</span>
          </button>

          <button class="button is-rounded px-2 control-button" title="Skip forward 30 seconds" @click="fastForward">
            <span class="material-symbols-outlined">fast_forward</span>
          </button>

          <button
              class="button is-rounded px-2 control-button"
              title="Skip to next in queue"
              :disabled="upcomingItems.length === 0"
              @click="skipNext">
            <span class="material-symbols-outlined">skip_next</span>
          </button>

        </div>
        <div class="player-right">
          <span>{{ useDurationFormat(currentTime).value }} / {{ useDurationFormat(duration).value }}</span>
          <div class="queue-toggle-wrapper">
            <button
                class="button is-rounded px-2 control-button queue-toggle-button"
                :class="{'has-text-info': showQueue}"
                title="Show queue and what's up next"
                @click="showQueue = !showQueue">
              <span class="material-symbols-outlined">playlist_play</span>
            </button>

            <div v-if="showQueue" ref="queuePopover" class="queue-popover box p-0">
            <div class="queue-popover-header px-4 py-3 is-flex is-align-items-center is-justify-content-space-between">
              <strong>Up Next</strong>
              <button
                  v-if="upcomingItems.length"
                  class="button is-small control-button"
                  title="Clear queue"
                  @click="clearQueue">
                <span class="material-symbols-outlined is-size-6">playlist_remove</span>
              </button>
            </div>
            <div v-if="upcomingItems.length === 0" class="px-4 py-3 has-text-grey">
              Nothing queued
            </div>
            <div ref="queueListEl" class="queue-list">
              <div
                  v-for="item in upcomingItems"
                  :key="item.guid"
                  class="queue-item is-flex is-align-items-center px-3 py-2 is-gap-2">
                <span class="material-symbols-outlined drag-handle has-text-grey" style="cursor: grab; touch-action: none;">
                  drag_indicator
                </span>
                <span class="is-flex-grow-1 is-size-7 queue-item-title">{{ item.title }}</span>
                <button
                    class="button is-small px-1 control-button"
                    title="Play now"
                    @click="playNow(item)">
                  <span class="material-symbols-outlined is-size-6">play_arrow</span>
                </button>
                <button
                    class="button is-small px-1 control-button"
                    title="Remove from queue"
                    @click="removeFromQueue(item)">
                  <span class="material-symbols-outlined is-size-6">close</span>
                </button>
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>
    </footer>
  </template>
</template>

<style scoped lang="scss">
.audio-player-section {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
}
.footer-placeholder {
    height: 100px;
}
.control-button {
    border: none;
}

.player-layout {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.player-left {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.player-center {
    display: flex;
    align-items: center;
    gap: 0.25rem;
}

.player-right {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
    white-space: nowrap;
}

.queue-toggle-wrapper {
    position: relative;
}

@media screen and (max-width: 768px) {
    .player-layout {
        flex-wrap: wrap;
        justify-content: center;
    }

    .player-left {
        flex-basis: 100%;
        text-align: center;
        font-size: 0.85rem;
    }

    .player-center {
        order: 0;
    }

    .player-right {
        flex-basis: 100%;
        justify-content: center;
        font-size: 0.85rem;
    }
}

input[type="range"].playback-progress {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 5px;
    outline: none;
    cursor: pointer;

    background: gray;

    &::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      height: 15px;
      width: 15px;
      background-color: #aced32;
      border-radius: 50%;
      border: 2px solid #aced32;
      transition: .2s ease-in-out;
    }
}

.queue-popover {
    position: absolute;
    bottom: 100%;
    right: 0;
    width: 350px;
    max-height: 400px;
    overflow-y: auto;
    margin-bottom: 8px;
    z-index: 10;

    @media screen and (max-width: 768px) {
        position: fixed;
        bottom: 100px;
        width: 90vw;
        left: 5vw;
        right: 5vw;
    }
}

.queue-popover-header {
    border-bottom: 1px solid hsl(0, 0%, 90%);
}

.queue-item {
    border-bottom: 1px solid hsl(0, 0%, 95%);

    &:last-child {
        border-bottom: none;
    }

    &:hover {
        background-color: hsl(0, 0%, 96%);
    }
}

.queue-item-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
