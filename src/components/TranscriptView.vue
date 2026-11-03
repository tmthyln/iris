<script setup lang="ts">
import {computed, ref, watch} from "vue"
import {useTranscriptStore} from "../stores/transcripts.ts"
import {useQueueStore} from "../stores/queue.ts"
import {groupIntoParagraphs} from "../transcriptParagraphs.ts"
import type {FeedItemPreview, Transcript, TranscriptSegment} from "../types"

const props = defineProps<{
    feedItem: FeedItemPreview,
    open: boolean,
}>()

const emit = defineEmits<{
    'update:open': [value: boolean]
}>()

const transcriptStore = useTranscriptStore()

const transcripts = computed<Transcript[]>(() => transcriptStore.getForItem(props.feedItem.guid))
// Finished transcripts, and the part of any other that has been transcribed so far.
const available = computed(() => transcripts.value.filter(t => t.status === 'complete' || t.chunks_done > 0))

const selectedId = ref<number | null>(null)

watch(available, list => {
    if (selectedId.value === null && list.length > 0) {
        selectedId.value = list[0].id
    } else if (selectedId.value !== null && !list.some(t => t.id === selectedId.value)) {
        selectedId.value = list[0]?.id ?? null
    }
    // The tabs are gone, so nothing could switch back to the show notes.
    if (list.length === 0 && props.open) emit('update:open', false)
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
const selected = computed(() => available.value.find(t => t.id === selectedId.value) ?? null)

const segments = computed<TranscriptSegment[]>(() => {
    const json = fullTranscript.value?.segments_json
    if (!json) return []
    try {
        const parsed: unknown = JSON.parse(json)
        return Array.isArray(parsed) ? parsed as TranscriptSegment[] : []
    } catch {
        return []
    }
})
const paragraphs = computed(() => groupIntoParagraphs(segments.value))

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

function languageName(code: string | null) {
    if (!code) return null
    try {
        return new Intl.DisplayNames(undefined, {type: 'language'}).of(code) ?? code
    } catch {
        return code
    }
}

function describeProgress(t: Transcript) {
    if (t.status === 'error') return `Stopped after part ${t.chunks_done} of ${t.chunks_total}: ${t.error_message}`
    return `Transcribing… ${t.chunks_done} of ${t.chunks_total} parts done`
}

// Requests of the same episode differ by when they ran, so that is what tells them apart.
function describeTranscript(t: Transcript) {
    const dt = t.completed_at ?? t.requested_at
    const date = new Date(dt).toLocaleString(undefined, {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'})
    const state = t.status === 'complete' ? '' : t.status === 'error' ? ' (incomplete)' : ' (in progress)'
    return [languageName(t.language), date].filter(Boolean).join(', ') + state
}

// Seeking goes through the queue store so it targets the player's actual
// playback state; an episode that is not playing starts from that point.
const queueStore = useQueueStore()
const isPlayingThisItem = computed(() => queueStore.currentlyPlaying?.guid === props.feedItem.guid)

function seekTo(seconds: number | undefined) {
    if (typeof seconds !== 'number') return
    void queueStore.playItemFrom(props.feedItem, seconds)
}

// The segment being spoken: the last one to have started.
const currentSegmentStart = computed(() => {
    if (!isPlayingThisItem.value) return null
    let current: number | null = null
    for (const {start} of segments.value) {
        if (start === undefined || start > queueStore.playbackPosition) break
        current = start
    }
    return current
})
</script>

<template>
  <div v-if="available.length > 0" class="transcript-view">
    <div class="transcript-header">
      <div class="tabs mb-0">
        <ul>
          <li :class="{'is-active': !open}">
            <a href="#" @click.prevent="emit('update:open', false)">Show notes</a>
          </li>
          <li :class="{'is-active': open}">
            <a href="#" @click.prevent="emit('update:open', true)">Transcript</a>
          </li>
        </ul>
      </div>
      <div v-if="open && available.length > 1" class="select is-small transcript-picker">
        <select v-model.number="selectedId" aria-label="Choose a transcript">
          <option v-for="t in available" :key="t.id" :value="t.id">
            {{ describeTranscript(t) }}
          </option>
        </select>
      </div>
    </div>

    <div v-if="open" class="transcript-body">
      <p v-if="selected && selected.status !== 'complete'" class="transcript-progress has-text-grey is-size-7">
        {{ describeProgress(selected) }}
      </p>
      <p v-if="!fullTranscript" class="has-text-grey">
        Loading transcript…
      </p>
      <template v-else-if="paragraphs.length > 0">
        <div
          v-for="paragraph in paragraphs"
          :key="paragraph.start"
          class="transcript-paragraph"
        >
          <button
            class="transcript-timestamp"
            :title="isPlayingThisItem ? `Jump to ${formatTime(paragraph.start)}` : `Play from ${formatTime(paragraph.start)}`"
            @click="seekTo(paragraph.start)"
          >
            {{ formatTime(paragraph.start) }}
          </button>
          <p class="transcript-text">
            <span
              v-for="segment in paragraph.segments"
              :key="segment.start"
              class="transcript-segment"
              :class="{'is-current': segment.start === currentSegmentStart}"
            >{{ segment.text }}</span>
          </p>
        </div>
      </template>
      <p v-else class="transcript-plain">
        {{ fullTranscript.text }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.transcript-view {
    margin-bottom: 1.5rem;
}
.transcript-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
}
.transcript-header .tabs {
    flex: 1 1 auto;
}
.transcript-picker {
    max-width: 100%;
}
.transcript-picker select {
    max-width: 100%;
    text-overflow: ellipsis;
}
.transcript-body {
    margin-top: 1.5rem;
}
.transcript-progress {
    margin-bottom: 1rem;
}
.transcript-paragraph {
    display: grid;
    grid-template-columns: 4rem minmax(0, 68ch);
    column-gap: 1rem;
    align-items: baseline;
    margin-bottom: 1.25rem;
}
.transcript-timestamp {
    justify-self: end;
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
    color: var(--bulma-text-weak);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
}
.transcript-timestamp:hover,
.transcript-timestamp:focus-visible {
    color: var(--bulma-link-text);
    text-decoration: underline;
}
.transcript-text {
    line-height: 1.7;
}
.transcript-segment.is-current {
    background: color-mix(in srgb, var(--bulma-primary) 22%, transparent);
    border-radius: 2px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
}
.transcript-plain {
    max-width: 68ch;
    line-height: 1.7;
    white-space: pre-wrap;
}
@media (max-width: 768px) {
    .transcript-paragraph {
        grid-template-columns: minmax(0, 1fr);
        row-gap: 0.125rem;
    }
    .transcript-timestamp {
        justify-self: start;
    }
}
</style>
