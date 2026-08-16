<script setup lang="ts">
import {computed, ref, watch} from "vue"
import {useTranscriptStore} from "../stores/transcripts.ts"
import {useQueueStore} from "../stores/queue.ts"
import type {Transcript, TranscriptSegment} from "../types"

const props = defineProps<{
    feedItemGuid: string,
    open: boolean,
}>()

const emit = defineEmits<{
    'update:open': [value: boolean]
}>()

const transcriptStore = useTranscriptStore()

const transcripts = computed<Transcript[]>(() => transcriptStore.getForItem(props.feedItemGuid))
const completed = computed(() => transcripts.value.filter(t => t.status === 'complete'))

const selectedId = ref<number | null>(null)

watch(completed, list => {
    if (selectedId.value === null && list.length > 0) {
        selectedId.value = list[0].id
    } else if (selectedId.value !== null && !list.some(t => t.id === selectedId.value)) {
        selectedId.value = list[0]?.id ?? null
    }
}, {immediate: true})

watch(selectedId, async id => {
    if (id !== null) await transcriptStore.loadFull(id)
})

watch(() => props.open, async isOpen => {
    if (isOpen && selectedId.value !== null) {
        await transcriptStore.loadFull(selectedId.value)
    }
})

const fullTranscript = computed(() => selectedId.value !== null ? transcriptStore.fullById[selectedId.value] : null)

const segments = computed<TranscriptSegment[]>(() => {
    const json = fullTranscript.value?.segments_json
    if (!json) return []
    try {
        const parsed = JSON.parse(json)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
})

function formatTime(seconds: number | undefined): string {
    if (typeof seconds !== 'number' || !isFinite(seconds)) return ''
    const total = Math.floor(seconds)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`
}

function describeTranscript(t: Transcript) {
    const dt = t.completed_at ?? t.requested_at
    const date = dt ? new Date(dt).toLocaleDateString() : ''
    const lang = t.language ?? '—'
    const model = t.model.split('/').pop() ?? t.model
    return `${model} · ${lang}${date ? ` · ${date}` : ''}`
}

// Seeking goes through the queue store so it targets the player's actual
// playback state — and only when this item is the one loaded; otherwise a
// timestamp click would scrub whatever other episode is currently playing.
const queueStore = useQueueStore()
const isPlayingThisItem = computed(() => queueStore.currentlyPlaying?.guid === props.feedItemGuid)

function seekTo(seconds: number | undefined) {
    if (typeof seconds !== 'number' || !isPlayingThisItem.value) return
    queueStore.requestSeek(seconds)
}

function toggle() {
    emit('update:open', !props.open)
}
</script>

<template>
  <div v-if="completed.length > 0" class="transcript-view mb-5">
    <div class="is-flex is-align-items-center is-gap-2 mb-2">
      <button class="button is-small" @click="toggle">
        <span class="material-symbols-outlined mr-2">
          {{ open ? 'expand_less' : 'expand_more' }}
        </span>
        Transcript
      </button>
      <div v-if="completed.length > 1" class="select is-small">
        <select v-model.number="selectedId">
          <option v-for="t in completed" :key="t.id" :value="t.id">
            {{ describeTranscript(t) }}
          </option>
        </select>
      </div>
      <span v-else-if="completed.length === 1 && open" class="has-text-grey is-size-7">
        {{ describeTranscript(completed[0]) }}
      </span>
    </div>

    <div v-if="open" class="transcript-body box">
      <p v-if="!fullTranscript" class="has-text-grey">Loading transcript…</p>
      <div v-else-if="segments.length > 0" class="transcript-segments">
        <div
            v-for="(seg, i) in segments" :key="i"
            class="transcript-segment">
          <button
              class="transcript-timestamp"
              :disabled="!isPlayingThisItem"
              :title="isPlayingThisItem ? `Seek to ${formatTime(seg.start)}` : 'Play this episode to seek from the transcript'"
              @click="seekTo(seg.start)">
            {{ formatTime(seg.start) }}
          </button>
          <span class="transcript-text">{{ seg.text }}</span>
        </div>
      </div>
      <p v-else class="transcript-plain">{{ fullTranscript.text }}</p>
    </div>
  </div>
</template>

<style scoped>
.transcript-body {
    max-height: 50vh;
    overflow-y: auto;
}
.transcript-segment {
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
    padding: 0.25rem 0;
}
.transcript-timestamp {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--bulma-link, #485fc7);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    min-width: 4rem;
    text-align: right;
    flex: 0 0 auto;
}
.transcript-timestamp:hover {
    text-decoration: underline;
}
.transcript-timestamp:disabled {
    color: var(--bulma-text-weak, #7a7a7a);
    cursor: default;
    text-decoration: none;
}
.transcript-text {
    flex: 1;
}
.transcript-plain {
    white-space: pre-wrap;
}
</style>
