<script setup lang="ts">
import {computed, onMounted, ref, toRef, watch} from "vue";
import {useDurationFormat} from "../format.ts";
import {unescapeHTML} from "../htmlproc.ts";
import {usePlaceholderImage} from "../placeholderImage.ts";
import {useQueueStore} from "../stores/queue.ts";
import {useFeedStore} from "../stores/feeds.ts";
import QueueList from "./QueueList.vue";

// The audio element and its state live in AudioPlayer, which stays mounted
// underneath, so this is only another set of controls over the same playback.
const props = defineProps<{
    playing: boolean,
    isLoading: boolean,
    currentTime: number,
    duration: number,
    rate: number,
}>()

const emit = defineEmits<{
    'close': [],
    'toggle-play': [],
    'rewind': [],
    'forward': [],
    'skip-next': [],
    'cycle-rate': [],
    'seek': [seconds: number],
}>()

const queueStore = useQueueStore()
const feedStore = useFeedStore()

const item = computed(() => queueStore.currentlyPlaying)
const feed = computed(() => item.value ? feedStore.getFeedById(item.value.source_feed) : null)
const episodeTitle = computed(() => unescapeHTML(item.value?.title ?? ''))
const feedTitle = computed(() => unescapeHTML(feed.value?.title ?? ''))
const nextTitle = computed(() => unescapeHTML(queueStore.upcoming[0]?.title ?? ''))

const {resolvedSrc: artwork, onImageError} = usePlaceholderImage(
    toRef(() => feed.value?.image_src),
    toRef(() => feed.value?.title ?? ''),
    512,
)

// showModal rather than a plain overlay: the rest of the page goes inert, focus
// stays inside, and Escape and Android's back gesture close it (see @close).
const dialog = ref<HTMLDialogElement>()
onMounted(() => dialog.value?.showModal())

/* Scrubbing: a drag only moves the slider, and the seek happens on release. */
const scrubPosition = ref<number | null>(null)
const position = computed(() => scrubPosition.value ?? props.currentTime)
const hasDuration = computed(() => props.duration > 0 && isFinite(props.duration))
const progress = computed(() => hasDuration.value ? 100 * position.value / props.duration : 0)

const elapsedLabel = useDurationFormat(position)
const remainingLabel = useDurationFormat(() => hasDuration.value ? Math.max(0, props.duration - position.value) : 0)

function onScrub(event: Event) {
    scrubPosition.value = Number((event.currentTarget as HTMLInputElement).value)
}
function onScrubEnd(event: Event) {
    if (scrubPosition.value === null) return
    emit('seek', Number((event.currentTarget as HTMLInputElement).value))
    scrubPosition.value = null
}
// A drag can end without a change event; the position it reached means nothing for another episode.
function cancelScrub() {
    scrubPosition.value = null
}
watch(() => item.value?.guid, cancelScrub)

/* On a phone the queue takes the artwork's place, keeping the controls under the thumb. */
const queueShown = ref(false)
const hasQueue = computed(() => queueStore.upcoming.length > 0)
watch(hasQueue, (has) => { if (!has) queueShown.value = false })

/* Dragging the top of the screen down closes it. */
const CLOSE_DRAG_DISTANCE = 100
const dragStart = ref<number | null>(null)
const dragDistance = ref(0)
function onDragStart(event: TouchEvent) {
    dragStart.value = event.touches[0].clientY
}
function onDragMove(event: TouchEvent) {
    if (dragStart.value === null) return
    dragDistance.value = Math.max(0, event.touches[0].clientY - dragStart.value)
}
function onDragEnd() {
    if (dragDistance.value > CLOSE_DRAG_DISTANCE) emit('close')
    dragStart.value = null
    dragDistance.value = 0
}
const dragStyle = computed(() => dragStart.value !== null && dragDistance.value > 0
    ? {transform: `translateY(${dragDistance.value}px)`, transition: 'none'}
    : {})
</script>

<template>
  <dialog
    ref="dialog"
    class="full-player"
    :class="{'has-queue': hasQueue, 'is-queue-shown': queueShown}"
    :style="dragStyle"
    aria-label="Player"
    @close="emit('close')"
  >
    <img
      class="ambient"
      :src="artwork"
      alt=""
      aria-hidden="true"
    >

    <div class="layout">
      <div
        class="top-bar"
        @touchstart.passive="onDragStart"
        @touchmove.passive="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd"
      >
        <button class="button is-rounded icon-button" title="Close full player" @click="emit('close')">
          <span class="material-symbols-outlined">keyboard_arrow_down</span>
        </button>
      </div>

      <div
        class="artwork"
        @touchstart.passive="onDragStart"
        @touchmove.passive="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd"
      >
        <img :src="artwork" :alt="feed?.image_alt ?? ''" @error="onImageError">
      </div>

      <QueueList v-if="hasQueue" class="queue-panel" roomy />

      <div v-if="item" class="now-playing">
        <router-link class="episode-title" :to="{name: 'item', params: {guid: item.guid}}">
          {{ episodeTitle }}
        </router-link>
        <router-link
          v-if="feed"
          class="feed-title"
          :to="{name: 'subscription', params: {guid: feed.guid}}"
        >
          {{ feedTitle }}
        </router-link>
      </div>

      <div class="scrubber">
        <input
          type="range"
          aria-label="Playback position"
          :min="0"
          :max="hasDuration ? duration : 0"
          :value="position"
          :disabled="isLoading"
          :style="{'--progress': `${progress}%`}"
          @input="onScrub"
          @change="onScrubEnd"
          @pointercancel="cancelScrub"
        >
        <div class="times">
          <span>{{ elapsedLabel }}</span>
          <span>-{{ remainingLabel }}</span>
        </div>
      </div>

      <div class="transport">
        <button
          class="button is-rounded icon-button rate-button"
          title="Change playback speed"
          :disabled="isLoading"
          @click="emit('cycle-rate')"
        >
          {{ rate }}x
        </button>
        <button
          class="button is-rounded icon-button"
          title="Rewind 10 seconds"
          :disabled="isLoading"
          @click="emit('rewind')"
        >
          <span class="material-symbols-outlined">replay_10</span>
        </button>
        <button
          class="button is-rounded play-button"
          :class="{'is-loading': isLoading}"
          :disabled="isLoading"
          :title="isLoading ? 'Loading...' : (playing ? 'Pause' : 'Play')"
          @click="emit('toggle-play')"
        >
          <span class="material-symbols-outlined">{{ playing ? 'pause' : 'play_arrow' }}</span>
        </button>
        <button
          class="button is-rounded icon-button"
          title="Skip forward 30 seconds"
          :disabled="isLoading"
          @click="emit('forward')"
        >
          <span class="material-symbols-outlined">forward_30</span>
        </button>
        <button
          class="button is-rounded icon-button"
          title="Skip to next in queue"
          :disabled="isLoading || !hasQueue"
          @click="emit('skip-next')"
        >
          <span class="material-symbols-outlined">skip_next</span>
        </button>
      </div>

      <button
        v-if="hasQueue"
        class="queue-toggle"
        :aria-expanded="queueShown"
        @click="queueShown = !queueShown"
      >
        <span class="material-symbols-outlined">{{ queueShown ? 'image' : 'playlist_play' }}</span>
        <span v-if="queueShown" class="queue-toggle-text">Hide queue</span>
        <span v-else class="queue-toggle-text">Up next: {{ nextTitle }}</span>
        <span v-if="!queueShown && queueStore.upcoming.length > 1" class="tag is-rounded">{{ queueStore.upcoming.length }}</span>
      </button>
    </div>
  </dialog>
</template>

<style>
/* Bulma puts the page's scrollbar on html, so that is what must stop scrolling behind the dialog. */
html:has(.full-player[open]) {
    overflow: hidden;
}
</style>

<style scoped lang="scss">
.full-player {
    position: fixed;
    inset: 0;
    width: 100vw;
    max-width: none;
    height: 100dvh;
    max-height: none;
    margin: 0;
    padding: 0;
    border: none;
    overflow: hidden;
    color: var(--bulma-text);
    background: hsl(var(--bulma-scheme-h), var(--bulma-scheme-s), var(--bulma-scheme-main-l));
    overscroll-behavior: contain;
    transition: transform 0.2s ease-out;
    animation: slide-up 0.2s ease-out;
}

@keyframes slide-up {
    from { transform: translateY(100%); }
}

// The show's own colours fill the screen, far enough back to keep text readable.
.ambient {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(64px) saturate(1.4);
    transform: scale(1.3);
    opacity: 0.22;
    pointer-events: none;
}

.layout {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto auto auto auto;
    grid-template-areas:
        "top"
        "stage"
        "info"
        "scrub"
        "transport"
        "toggle";
    height: 100%;
    max-width: 32rem;
    margin: 0 auto;
    padding: 0.5rem 1.25rem max(0.75rem, env(safe-area-inset-bottom));
}

.top-bar {
    grid-area: top;
    margin: 0 -0.5rem;
    touch-action: none;
}

.artwork {
    grid-area: stage;
    container-type: size;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
    padding: 0.5rem 0 1rem;
    touch-action: none;

    img {
        display: block;
        width: min(100cqw, 100cqh);
        height: min(100cqw, 100cqh);
        object-fit: cover;
        border-radius: 0.75rem;
        box-shadow: 0 1rem 2.5rem rgba(0, 0, 0, 0.3);
    }
}

.layout .queue-panel {
    grid-area: stage;
    display: none;
    margin: 0 -1.25rem 0.75rem;
}

.is-queue-shown {
    .artwork {
        display: none;
    }

    .layout .queue-panel {
        display: flex;
    }
}

.now-playing {
    grid-area: info;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
}

.episode-title {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    color: var(--bulma-text-strong);
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 1.3;
}

.feed-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--bulma-text);
}

.scrubber {
    grid-area: scrub;
    margin-top: 0.5rem;
}

.times {
    display: flex;
    justify-content: space-between;
    margin-top: -0.375rem;
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
    color: var(--bulma-text);
}

input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    display: block;
    width: 100%;
    height: 2.75rem;
    margin: 0;
    background: transparent;
    cursor: pointer;

    &:disabled {
        cursor: default;
    }

    &::-webkit-slider-runnable-track {
        height: 6px;
        border-radius: 3px;
        background: linear-gradient(to right, var(--bulma-info) var(--progress), var(--bulma-border) var(--progress));
    }

    &::-moz-range-track {
        height: 6px;
        border-radius: 3px;
        background: var(--bulma-border);
    }

    &::-moz-range-progress {
        height: 6px;
        border-radius: 3px;
        background: var(--bulma-info);
    }

    &::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 18px;
        height: 18px;
        margin-top: -6px;
        border: none;
        border-radius: 50%;
        background-color: var(--bulma-info);
    }

    &::-moz-range-thumb {
        width: 18px;
        height: 18px;
        border: none;
        border-radius: 50%;
        background-color: var(--bulma-info);
    }
}

.transport {
    grid-area: transport;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.25rem 0 0.5rem;
}

.icon-button {
    width: 3rem;
    height: 3rem;
    padding: 0;
    border: none;
    background: transparent;

    .material-symbols-outlined {
        font-size: 2rem;
    }
}

.icon-button[disabled] {
    background: transparent;
}

.rate-button {
    font-size: 0.9375rem;
    font-variant-numeric: tabular-nums;
}

.play-button {
    width: 4.5rem;
    height: 4.5rem;
    padding: 0;
    border: none;
    color: var(--bulma-info-invert);
    background: var(--bulma-info);

    .material-symbols-outlined {
        font-size: 2.75rem;
        font-variation-settings: 'FILL' 1;
    }
}

.queue-toggle {
    grid-area: toggle;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    min-height: 2.75rem;
    padding: 0;
    border: none;
    font: inherit;
    font-size: 0.875rem;
    text-align: left;
    color: var(--bulma-text);
    background: none;
    cursor: pointer;
}

.queue-toggle-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

// Enough room for both side by side, so the queue no longer has to be asked for.
@media screen and (min-width: 769px), screen and (orientation: landscape) {
    .has-queue .layout {
        grid-template-columns: minmax(0, 1fr) minmax(18rem, 26rem);
        grid-template-rows: auto minmax(0, 1fr) auto auto auto;
        grid-template-areas:
            "top       queue"
            "stage     queue"
            "info      queue"
            "scrub     queue"
            "transport queue";
        column-gap: 2rem;
        max-width: 72rem;
        padding-bottom: max(1.5rem, env(safe-area-inset-bottom));
    }

    .layout .queue-panel,
    .is-queue-shown .layout .queue-panel {
        grid-area: queue;
        display: flex;
        margin: 0.5rem 0 0;
        border-radius: 0.75rem;
        background: color-mix(in srgb, hsl(var(--bulma-scheme-h), var(--bulma-scheme-s), var(--bulma-scheme-main-l)) 60%, transparent);
    }

    .is-queue-shown .artwork {
        display: flex;
    }

    .queue-toggle {
        display: none;
    }

    .transport {
        justify-self: center;
        width: 100%;
        max-width: 26rem;
    }
}

// A phone on its side: the controls need the height more than the artwork does.
@media screen and (orientation: landscape) and (max-height: 500px) {
    .layout {
        padding-top: 0;
        padding-bottom: 0.25rem;
    }

    .artwork {
        padding: 0;
    }

    .episode-title {
        font-size: 1rem;
        -webkit-line-clamp: 1;
        line-clamp: 1;
    }

    .scrubber {
        margin-top: 0;
    }

    .play-button {
        width: 3.25rem;
        height: 3.25rem;
    }

    // With no queue beside it, the artwork takes that side instead.
    .full-player:not(.has-queue) .layout {
        grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
        grid-template-rows: auto minmax(0, 1fr) auto auto;
        grid-template-areas:
            "top   top"
            "stage info"
            "stage scrub"
            "stage transport";
        column-gap: 2rem;
        max-width: 48rem;
    }

    .full-player:not(.has-queue) .now-playing {
        justify-content: flex-end;
    }
}

@media (prefers-reduced-motion: reduce) {
    .full-player {
        transition: none;
        animation: none;
    }
}
</style>
