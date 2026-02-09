<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {useIntervalFn, useMediaControls} from "@vueuse/core";
import {useDurationFormat} from "../format.ts";
import {useQueueStore} from "../stores/queue.ts";

const queueStore = useQueueStore()

const currentItem = computed(() => queueStore.currentlyPlaying)

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

watch(() => queueStore.paused, (paused) => {
    playing.value = !paused
})
watch(playing, (isPlaying) => {
    queueStore.paused = !isPlaying
})

function setPlaybackPosition(event: Event) {
    const target = event.currentTarget as HTMLInputElement
    currentTime.value = Number(target.value)
}
function fastRewind() {
    currentTime.value = Math.max(0, currentTime.value - 15)
}
function fastForward() {
    currentTime.value = Math.min(duration.value, currentTime.value + 30)
}

const playbackRates = [1, 1.25, 1.5, 1.75, 2, 0.25, 0.5]
function cyclePlaybackRate() {
    const currentIndex = playbackRates.indexOf(rate.value)
    const nextIndex = (currentIndex + 1) % playbackRates.length
    rate.value = playbackRates[nextIndex]
}

const {pause: pauseUpdates, resume: resumeUpdates} = useIntervalFn(() => {
    // TODO: update progress with latest position
}, 5000)
watch(ended, () => {
    if (ended.value) {
        // TODO: handle playback ended
    }
})
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
      <div class="level p-4 is-flex-grow-1">
        <audio ref="audio"></audio>

        <div class="level-left">
          {{ currentItem?.title }}
        </div>
        <div class="level-item is-gap-1">

          <button class="button is-rounded px-2 control-button">
            <span class="material-symbols-outlined">skip_previous</span>
          </button>

          <button class="button is-rounded px-2 control-button" @click="fastRewind">
            <span class="material-symbols-outlined">fast_rewind</span>
          </button>

          <button class="button is-rounded px-3 is-large control-button" @click="playing = !playing">
            <span v-if="!playing" class="material-symbols-outlined">play_arrow</span>
            <span v-else class="material-symbols-outlined">pause</span>
          </button>

          <button class="button is-rounded px-2 control-button" @click="fastForward">
            <span class="material-symbols-outlined">fast_forward</span>
          </button>

          <button class="button is-rounded px-2 control-button">
            <span class="material-symbols-outlined">skip_next</span>
          </button>

          <button class="tag button" @click="cyclePlaybackRate">
            {{ rate }}x
          </button>

        </div>
        <div class="level-right">
          <span>{{ useDurationFormat(currentTime).value }} / {{ useDurationFormat(duration).value }}</span>
          <button class="button is-rounded px-2 control-button" title="Show queue and what's up next">
            <span class="material-symbols-outlined">playlist_play</span>
          </button>
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
    height: 100px;
    margin-top: 100px;
}
.footer-placeholder {
    height: 100px;
}
.control-button {
    border: none;
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
</style>