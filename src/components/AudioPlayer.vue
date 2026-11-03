<script setup lang="ts">
import {computed, ref, watch, watchEffect} from "vue";
import {useEventListener, useIntervalFn, useMediaControls, onClickOutside} from "@vueuse/core";
import {useRoute, useRouter} from "vue-router";
import {useDurationFormat} from "../format.ts";
import {useQueueStore} from "../stores/queue.ts";
import {useFeedItemStore} from "../stores/feeditems.ts";
import {useFeedStore} from "../stores/feeds.ts";
import {useDownloadStore} from "../stores/downloads.ts";
import {unescapeHTML} from "../htmlproc.ts";
import {report} from "../telemetry.ts";
import FullPlayer from "./FullPlayer.vue";
import QueueList from "./QueueList.vue";

const queueStore = useQueueStore()
const feedItemStore = useFeedItemStore()
const feedStore = useFeedStore()
const downloadStore = useDownloadStore()

const currentItem = computed(() => queueStore.currentlyPlaying)
const currentTitle = computed(() => unescapeHTML(currentItem.value?.title ?? ''))

const resolvedSrc = ref('')
let resolvedGuid: string | null = null

// Everything read before the first `await` is tracked by the effect.
async function resolveSource() {
    const item = currentItem.value
    if (!item?.enclosure_url) {
        resolvedSrc.value = ''
        return
    }
    if (downloadStore.isDownloaded(item.guid)) {
        // A download finishing mid-episode must not swap the source, which would
        // reload the audio from the start; it is used the next time this loads.
        const element = audio.value
        if (resolvedGuid === item.guid && element && (!element.paused || element.currentTime > 0)) return

        const localUrl = await downloadStore.getLocalUrl(item.guid)
        if (localUrl && currentItem.value?.guid === item.guid) {
            resolvedGuid = item.guid
            resolvedSrc.value = localUrl
            return
        }
    }
    resolvedGuid = item.guid
    resolvedSrc.value = item.enclosure_url
}

const audio = ref<HTMLAudioElement>()
watchEffect(() => void resolveSource())
const {
    playing,
    rate,
    currentTime,
    duration,
    ended,
    onSourceError,
    onPlaybackError,
} = useMediaControls(audio, {
    src: resolvedSrc,
})

// The audio element loads remote episodes straight from the publisher, so the
// Worker never sees these requests; this report is the only trace of them.
function reportAudioError(kind: string, error?: unknown) {
    const element = audio.value
    const mediaError = element?.error
    report('error', `Audio playback failed: ${kind}`, {
        error,
        details: {
            feedItemGuid: currentItem.value?.guid,
            enclosureUrl: currentItem.value?.enclosure_url,
            enclosureType: currentItem.value?.enclosure_type,
            source: resolvedSrc.value.startsWith('blob:') ? 'download' : 'remote',
            mediaErrorCode: mediaError?.code ?? null,
            mediaErrorMessage: mediaError?.message || null,
            networkState: element?.networkState,
            readyState: element?.readyState,
            currentTime: currentTime.value,
            duration: Number.isFinite(duration.value) ? duration.value : null,
        },
    })
}
// A <source> that fails to load (bad URL, HTTP error, unsupported type).
onSourceError(() => reportAudioError('source could not be loaded'))
// Decode errors and network failures after loading began.
useEventListener(audio, 'error', () => reportAudioError('media error'))
// play() rejected (autoplay policy, unsupported source).
onPlaybackError((err) => reportAudioError('play() was rejected', err))

const currentItemReady = computed(() =>
    !!currentItem.value && resolvedSrc.value !== '' && duration.value > 0 && isFinite(duration.value)
)
const isLoading = computed(() =>
    queueStore.loadState === 'loading' || (!!currentItem.value && !currentItemReady.value)
)

const autoPlayNext = ref(false)

watch(duration, (newDuration) => {
    if (newDuration > 0 && currentItem.value) {
        if (currentItem.value.progress > 0 && currentItem.value.progress < 1) {
            currentTime.value = currentItem.value.progress * newDuration
        }
        if (queueStore.pendingStart?.guid === currentItem.value.guid) {
            currentTime.value = Math.min(queueStore.pendingStart.seconds, newDuration)
            queueStore.pendingStart = null
        }
        if (autoPlayNext.value) {
            playing.value = true
            autoPlayNext.value = false
        }
    }
})

watch(currentTime, (time) => {
    queueStore.playbackPosition = time
})

watch(() => queueStore.paused, (paused) => {
    playing.value = !paused
})
watch(playing, (isPlaying) => {
    queueStore.paused = !isPlaying
    if (!isPlaying && currentItem.value && duration.value > 0) {
        void feedItemStore.updateItemProgress(currentItem.value, currentTime.value / duration.value)
    }
})

function seek(seconds: number) {
    currentTime.value = seconds
    if (currentItem.value && duration.value > 0) {
        void feedItemStore.updateItemProgress(currentItem.value, currentTime.value / duration.value)
    }
}
function setPlaybackPosition(event: Event) {
    seek(Number((event.currentTarget as HTMLInputElement).value))
}
watch(() => queueStore.pendingSeek, (seconds) => {
    if (seconds === null) return
    queueStore.pendingSeek = null
    if (!currentItemReady.value) return
    seek(Math.min(Math.max(0, seconds), duration.value))
})
function fastRewind() {
    currentTime.value = Math.max(0, currentTime.value - 10)
}
function fastForward() {
    currentTime.value = Math.min(duration.value, currentTime.value + 30)
}
async function skipNext() {
    if (!currentItem.value || queueStore.upcoming.length === 0) return
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
        void feedItemStore.updateItemProgress(currentItem.value, currentTime.value / duration.value)
    }
}, 5000)
watch(ended, async () => {
    if (ended.value && currentItem.value) {
        const completedGuid = currentItem.value.guid
        await feedItemStore.updateItemProgress(currentItem.value, 1)
        autoPlayNext.value = queueStore.upcoming.length > 0
        await queueStore.removeItem(currentItem.value)
        if (downloadStore.isDownloaded(completedGuid)) {
            void downloadStore.scheduleDelete(completedGuid, 60_000)
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
    navigator.mediaSession.setActionHandler('play', () => { if (!isLoading.value) playing.value = true })
    navigator.mediaSession.setActionHandler('pause', () => { if (!isLoading.value) playing.value = false })
    navigator.mediaSession.setActionHandler('seekbackward', () => { if (!isLoading.value) fastRewind() })
    navigator.mediaSession.setActionHandler('seekforward', () => { if (!isLoading.value) fastForward() })
    navigator.mediaSession.setActionHandler('nexttrack', () => { if (!isLoading.value) void skipNext() })
}

/* Queue popover */
const showQueue = ref(false)
const queuePopover = ref<HTMLElement>()

onClickOutside(queuePopover, () => {
    showQueue.value = false
}, {ignore: ['.queue-toggle-button']})

watch(() => queueStore.upcoming.length, (count) => {
    if (count === 0) showQueue.value = false
})

/* Full screen player */
// Open while the URL says so, which gives it a history entry: Back closes it,
// and Back from a page reached through one of its links returns to it.
const FULL_PLAYER_HASH = '#player'
const route = useRoute()
const router = useRouter()
const fullPlayerOpen = computed(() => route.hash === FULL_PLAYER_HASH)

function openFullPlayer() {
    showQueue.value = false
    void router.push({path: route.path, query: route.query, hash: FULL_PLAYER_HASH, state: {openedOverPage: true}})
}

let closingFullPlayer = false
function closeFullPlayer() {
    if (!fullPlayerOpen.value || closingFullPlayer) return
    closingFullPlayer = true
    // Opened over this page: undo the entry. Otherwise (a shared link) there is nothing to go back to.
    if (router.options.history.state.openedOverPage) router.back()
    else void router.replace({path: route.path, query: route.query})
}
watch(fullPlayerOpen, () => { closingFullPlayer = false })

// The last episode finished or was removed, or a reload found the queue empty.
watchEffect(() => {
    const settled = queueStore.loadState !== 'unloaded' && queueStore.loadState !== 'loading'
    if (settled && queueStore.items.length === 0) closeFullPlayer()
})
</script>

<template>
  <template v-if="queueStore.items.length">
    <div class="footer-placeholder" />
    <footer class="audio-player-section has-background is-flex is-flex-direction-column is-align-items-stretch is-justify-content-space-between">
      <input
        class="playback-progress p-0 m-0"
        type="range"
        :min="0"
        :max="duration"
        :value="currentTime"
        @input="setPlaybackPosition"
        :disabled="isLoading"
        :style="{'--progress': `${100*currentTime/duration}%`}"
      >
      <div class="player-layout p-4 is-flex-grow-1">
        <audio ref="audio" />

        <div class="player-left">
          <button class="player-title" title="Open full player" @click="openFullPlayer">
            {{ currentTitle }}
          </button>
        </div>
        <div class="player-center">
          <button class="tag button" :disabled="isLoading" @click="cyclePlaybackRate">
            {{ rate }}x
          </button>

          <button
            class="button is-rounded px-2 control-button"
            title="Rewind 10 seconds"
            :disabled="isLoading"
            @click="fastRewind"
          >
            <span class="material-symbols-outlined">fast_rewind</span>
          </button>

          <button
            class="button is-rounded px-3 is-large control-button"
            :class="{'is-loading': isLoading}"
            :disabled="isLoading"
            :title="isLoading ? 'Loading...' : (playing ? 'Pause' : 'Play')"
            @click="playing = !playing"
          >
            <span v-if="!playing" class="material-symbols-outlined">play_arrow</span>
            <span v-else class="material-symbols-outlined">pause</span>
          </button>

          <button
            class="button is-rounded px-2 control-button"
            title="Skip forward 30 seconds"
            :disabled="isLoading"
            @click="fastForward"
          >
            <span class="material-symbols-outlined">fast_forward</span>
          </button>

          <button
            class="button is-rounded px-2 control-button"
            title="Skip to next in queue"
            :disabled="isLoading || queueStore.upcoming.length === 0"
            @click="skipNext"
          >
            <span class="material-symbols-outlined">skip_next</span>
          </button>
        </div>
        <div class="player-right">
          <span>{{ useDurationFormat(currentTime).value }} / {{ useDurationFormat(duration).value }}</span>
          <div v-if="queueStore.upcoming.length" class="queue-toggle-wrapper">
            <button
              class="button is-rounded px-2 control-button queue-toggle-button"
              :class="{'has-text-info': showQueue}"
              title="Show queue and what's up next"
              @click="showQueue = !showQueue"
            >
              <span class="material-symbols-outlined">playlist_play</span>
            </button>

            <div v-if="showQueue" ref="queuePopover" class="queue-popover box p-0">
              <QueueList />
            </div>
          </div>
          <button
            class="button is-rounded px-2 control-button"
            title="Open full player"
            @click="openFullPlayer"
          >
            <span class="material-symbols-outlined">open_in_full</span>
          </button>
        </div>
      </div>
    </footer>
    <FullPlayer
      v-if="fullPlayerOpen"
      :playing="playing"
      :is-loading="isLoading"
      :current-time="currentTime"
      :duration="duration"
      :rate="rate"
      @close="closeFullPlayer"
      @toggle-play="playing = !playing"
      @rewind="fastRewind"
      @forward="fastForward"
      @skip-next="skipNext"
      @cycle-rate="cyclePlaybackRate"
      @seek="seek"
    />
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

.player-title {
    display: block;
    width: 100%;
    padding: 0;
    border: none;
    overflow: hidden;
    font: inherit;
    text-align: inherit;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: inherit;
    background: none;
    cursor: pointer;
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
    background: transparent;

    &::-webkit-slider-runnable-track {
      height: 5px;
      background: linear-gradient(to right, var(--bulma-info) var(--progress), var(--bulma-border) var(--progress));
    }

    &::-moz-range-track {
      height: 5px;
      background: var(--bulma-border);
    }

    &::-moz-range-progress {
      height: 5px;
      background: var(--bulma-info);
    }

    &::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      height: 15px;
      width: 15px;
      background-color: var(--bulma-info);
      border-radius: 50%;
      border: 2px solid var(--bulma-info);
      margin-top: -5px;
    }

    &::-moz-range-thumb {
      height: 15px;
      width: 15px;
      background-color: var(--bulma-info);
      border-radius: 50%;
      border: 2px solid var(--bulma-info);
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
</style>
