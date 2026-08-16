import {defineStore} from "pinia"
import {reactive, ref} from "vue"
import {useDocumentVisibility, useIntervalFn} from "@vueuse/core"
import client from "../client"
import type {Transcript, TranscriptFull} from "../types"

const POLL_INTERVAL_MS = 5000
// Stop polling after this many consecutive failed fetches; a later
// refresh()/request() for the item will start a fresh poller.
const MAX_CONSECUTIVE_FAILURES = 5

function hasInProgress(transcripts: Transcript[]) {
    return transcripts.some(t => t.status === 'pending' || t.status === 'processing')
}

export const useTranscriptStore = defineStore('transcripts', () => {
    const byItem = reactive<Record<string, Transcript[]>>({})
    const fullById = reactive<Record<number, TranscriptFull>>({})
    const loading = ref<Record<string, boolean>>({})

    const visibility = useDocumentVisibility()
    // One poller per item; the map value is the interval's pause handle so
    // the interval is always stopped before the map entry is dropped.
    const pollers = new Map<string, () => void>()

    function stopPolling(itemGuid: string) {
        pollers.get(itemGuid)?.()
        pollers.delete(itemGuid)
    }

    function ensurePolling(itemGuid: string) {
        if (pollers.has(itemGuid)) return
        let failures = 0
        const {pause} = useIntervalFn(async () => {
            if (visibility.value !== 'visible') return
            const result = await client.listTranscripts(itemGuid)
            const list = result.ok ? result.data : null
            if (!list) {
                if (++failures >= MAX_CONSECUTIVE_FAILURES) stopPolling(itemGuid)
                return
            }
            failures = 0
            byItem[itemGuid] = list
            if (!hasInProgress(list)) stopPolling(itemGuid)
        }, POLL_INTERVAL_MS)
        pollers.set(itemGuid, pause)
    }

    async function refresh(itemGuid: string) {
        loading.value[itemGuid] = true
        const result = await client.listTranscripts(itemGuid)
        const list = result.ok ? result.data : null
        loading.value[itemGuid] = false
        if (list) {
            byItem[itemGuid] = list
            if (hasInProgress(list)) {
                ensurePolling(itemGuid)
            } else {
                stopPolling(itemGuid)
            }
        }
        return list
    }

    async function request(itemGuid: string, opts: {model?: string, language?: string} = {}) {
        const result = await client.requestTranscript(itemGuid, opts)
        const created = result.ok ? result.data : null
        if (created) {
            // The server dedupes active requests, so `created` may be a
            // transcript we already know about.
            const others = (byItem[itemGuid] ?? []).filter(t => t.id !== created.id)
            byItem[itemGuid] = [created, ...others]
            ensurePolling(itemGuid)
        }
        return created
    }

    async function loadFull(transcriptId: number) {
        if (fullById[transcriptId]) return fullById[transcriptId]
        const result = await client.getTranscript(transcriptId)
        const full = result.ok ? result.data : null
        if (full) fullById[transcriptId] = full
        return full
    }

    function getForItem(itemGuid: string): Transcript[] {
        return byItem[itemGuid] ?? []
    }

    function latest(itemGuid: string): Transcript | null {
        const list = byItem[itemGuid]
        return list && list.length > 0 ? list[0] : null
    }

    return {byItem, fullById, loading, refresh, request, loadFull, getForItem, latest}
})
