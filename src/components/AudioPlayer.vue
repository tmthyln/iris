<script setup lang="ts">
import {ref, watch} from "vue";
import {useIntervalFn, useMediaControls} from "@vueuse/core";
import {useDurationFormat} from "../format.ts";

const audio = ref<HTMLAudioElement>()
const {
    playing,
    rate,
    currentTime,
    duration,
    ended,
} = useMediaControls(audio, {
    src: 'https://media.transistor.fm/97a0251c/e2001ce8.mp3',
})

function setPlaybackPosition(event: InputEvent) {
    currentTime.value = event.currentTarget.value
}
function fastRewind() {
    currentTime.value = Math.max(0, currentTime.value - 15)
}
function fastForward() {
    currentTime.value = Math.min(duration.value, currentTime.value + 30)
}

function cyclePlaybackRate() {
    switch (rate.value) {
        case 1:
            rate.value = 1.25
            break
        case 1.25:
            rate.value = 1.5
            break
        case 1.5:
            rate.value = 1.75
            break
        case 1.75:
            rate.value = 2
            break
        case 2:
            rate.value = 0.25
            break
        case 0.25:
            rate.value = 0.5
            break
        case 0.5:
            rate.value = 1
            break
    }
}

const {pause, resume} = useIntervalFn(() => {
    console.log('tick')
}, 5000)
watch(
    ended,
    () => {
        if (ended.value) {
            console.log('ended')
        }
    }
)
</script>

<template>
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
        About the podcast/episode
      </div>
      <div class="level-item is-gap-1">

        <button
            class="button is-rounded px-2"
            style="border: none;">
          <span class="material-symbols-outlined">
            skip_previous
          </span>
        </button>

        <button
            class="button is-rounded px-2"
            style="border: none;"
            @click="fastRewind">
          <span class="material-symbols-outlined">
            fast_rewind
          </span>
        </button>

        <button
            class="button is-rounded px-3 is-large"
            style="border: none;"
            @click="playing = !playing">
          <span v-if="!playing" class="material-symbols-outlined">
            play_arrow
          </span>
          <span v-else class="material-symbols-outlined">
            pause
          </span>
        </button>

        <button
            class="button is-rounded px-2"
            style="border: none;"
            @click="fastForward">
          <span class="material-symbols-outlined">
            fast_forward
          </span>
        </button>

        <button
            class="button is-rounded px-2"
            style="border: none;">
          <span class="material-symbols-outlined">
            skip_next
          </span>
        </button>

        <button class="tag button" @click="cyclePlaybackRate">
          {{ rate }}x
        </button>

      </div>
      <div class="level-right">
        <span>{{ useDurationFormat(currentTime).value }} / {{ useDurationFormat(duration).value }}</span>
        <button
            class="button is-rounded px-2"
            style="border: none;"
            title="Show queue and what's up next">
          <span class="material-symbols-outlined">
            playlist_play
          </span>
        </button>
      </div>
    </div>
  </footer>
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