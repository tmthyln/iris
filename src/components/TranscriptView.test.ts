import {afterEach, describe, expect, it, vi} from 'vitest'
import {useQueueStore} from '../stores/queue.ts'
import {useTranscriptStore} from '../stores/transcripts.ts'
import {makeFullTranscript, makeItem, makeTranscript, ok, stubClient, mountApp} from '../testing/helpers.ts'
import TranscriptView from './TranscriptView.vue'

afterEach(() => vi.restoreAllMocks())

const GUID = 'item-under-test'
const ITEM = makeItem({guid: GUID})

const SEGMENTS = JSON.stringify([
    {start: 0, end: 4, text: 'Hello and welcome.'},
    {start: 65, end: 70, text: 'One minute in.'},
    {start: 3700, end: 3705, text: 'One hour in.'},
])

async function mountTranscripts({transcripts = [makeTranscript({status: 'complete'})], open = false} = {}) {
    const mounted = await mountApp(TranscriptView, {props: {feedItem: ITEM, open}})
    useTranscriptStore().byItem[GUID] = transcripts
    await mounted.wrapper.vm.$nextTick()
    return mounted
}

describe('visibility', () => {
    it('renders nothing until some of a transcript is available', async () => {
        const {wrapper} = await mountTranscripts({transcripts: [makeTranscript({status: 'pending'})]})
        expect(wrapper.find('.transcript-view').exists()).toBe(false)
    })

    it('switches between the show notes and the transcript through the parent', async () => {
        const {wrapper} = await mountTranscripts()
        const tabs = wrapper.findAll('.tabs a')
        expect(tabs.map(tab => tab.text())).toEqual(['Show notes', 'Transcript'])
        expect(wrapper.find('.tabs .is-active').text()).toBe('Show notes')
        expect(wrapper.find('.transcript-body').exists()).toBe(false)

        await tabs[1].trigger('click')
        await tabs[0].trigger('click')
        expect(wrapper.emitted('update:open')).toEqual([[true], [false]])
    })

    it('hands back to the show notes if no transcript is left to show', async () => {
        const complete = makeTranscript({status: 'complete'})
        stubClient('getTranscript', ok(makeFullTranscript({id: complete.id})))
        const {wrapper} = await mountApp(TranscriptView, {props: {feedItem: ITEM, open: true}})
        const store = useTranscriptStore()
        store.byItem[GUID] = [complete]
        await wrapper.vm.$nextTick()
        const before = wrapper.emitted('update:open')?.length ?? 0

        store.byItem[GUID] = []
        await wrapper.vm.$nextTick()
        expect(wrapper.emitted('update:open')?.slice(before)).toEqual([[false]])
    })
})

describe('content', () => {
    it('loads and renders timestamped paragraphs when open', async () => {
        const complete = makeTranscript({status: 'complete'})
        stubClient('getTranscript', ok(makeFullTranscript({id: complete.id, segments_json: SEGMENTS})))
        const {wrapper} = await mountTranscripts({transcripts: [complete], open: true})
        await vi.waitFor(() => expect(wrapper.findAll('.transcript-segment')).toHaveLength(3))
        expect(wrapper.findAll('.transcript-paragraph')).toHaveLength(3)

        const stamps = wrapper.findAll('.transcript-timestamp').map(b => b.text())
        expect(stamps).toEqual(['0:00', '1:05', '1:01:40'])
        expect(wrapper.text()).toContain('One minute in.')
    })

    it('falls back to the plain text when there are no segments', async () => {
        const complete = makeTranscript({status: 'complete'})
        stubClient('getTranscript', ok(makeFullTranscript({id: complete.id, text: 'Just a wall of text.', segments_json: 'not-json'})))
        const {wrapper} = await mountTranscripts({transcripts: [complete], open: true})
        await vi.waitFor(() => expect(wrapper.find('.transcript-plain').text()).toBe('Just a wall of text.'))
    })

    it('shows the part transcribed so far while the rest is in progress', async () => {
        const partial = makeTranscript({status: 'processing', chunks_done: 4, chunks_total: 8})
        stubClient('getTranscript', ok(makeFullTranscript({...partial, segments_json: SEGMENTS})))
        const {wrapper} = await mountTranscripts({transcripts: [partial], open: true})

        await vi.waitFor(() => expect(wrapper.findAll('.transcript-segment')).toHaveLength(3))
        expect(wrapper.find('.transcript-progress').text()).toBe('Transcribing… 4 of 8 parts done')
    })

    it('keeps the part transcribed before a failure', async () => {
        const failed = makeTranscript({status: 'error', error_message: 'capacity', chunks_done: 4, chunks_total: 8})
        stubClient('getTranscript', ok(makeFullTranscript({...failed, segments_json: SEGMENTS})))
        const {wrapper} = await mountTranscripts({transcripts: [failed], open: true})

        await vi.waitFor(() => expect(wrapper.findAll('.transcript-segment')).toHaveLength(3))
        expect(wrapper.find('.transcript-progress').text()).toBe('Stopped after part 4 of 8: capacity')
    })

    it('hides the progress note once complete', async () => {
        const complete = makeTranscript({status: 'complete', chunks_done: 8, chunks_total: 8})
        stubClient('getTranscript', ok(makeFullTranscript({...complete, segments_json: SEGMENTS})))
        const {wrapper} = await mountTranscripts({transcripts: [complete], open: true})

        await vi.waitFor(() => expect(wrapper.findAll('.transcript-segment')).toHaveLength(3))
        expect(wrapper.find('.transcript-progress').exists()).toBe(false)
    })

    it('offers a picker telling several transcripts apart once open', async () => {
        const first = makeTranscript({status: 'complete', language: 'en', completed_at: '2026-11-02T12:00:00.000Z'})
        const partial = makeTranscript({status: 'processing', language: 'zh', chunks_done: 2, chunks_total: 4})
        stubClient('getTranscript', ok(makeFullTranscript({id: first.id})))
        const {wrapper} = await mountTranscripts({transcripts: [first, partial], open: true})

        const options = wrapper.findAll('option')
        expect(options).toHaveLength(2)
        expect(options[0].text()).toMatch(/^English, Nov 2, 2026/)
        expect(options[1].text()).toMatch(/^Chinese, .*\(in progress\)$/)
    })

    it('shows no picker for a single transcript', async () => {
        const complete = makeTranscript({status: 'complete'})
        stubClient('getTranscript', ok(makeFullTranscript({id: complete.id})))
        const {wrapper} = await mountTranscripts({transcripts: [complete], open: true})
        expect(wrapper.find('select').exists()).toBe(false)
    })
})

describe('seeking', () => {
    async function mountOpen() {
        const complete = makeTranscript({status: 'complete'})
        stubClient('getTranscript', ok(makeFullTranscript({id: complete.id, segments_json: SEGMENTS})))
        const mounted = await mountTranscripts({transcripts: [complete], open: true})
        await vi.waitFor(() => expect(mounted.wrapper.findAll('.transcript-timestamp')).toHaveLength(3))
        return mounted.wrapper
    }

    it('jumps within the episode while it is playing', async () => {
        const wrapper = await mountOpen()
        const queueStore = useQueueStore()
        queueStore.items = [ITEM]
        await wrapper.vm.$nextTick()

        await wrapper.findAll('.transcript-timestamp')[1].trigger('click')
        expect(queueStore.pendingSeek).toBe(65)
    })

    it('starts the episode from that point when it is not playing', async () => {
        const wrapper = await mountOpen()
        const queueStore = useQueueStore()
        const playItem = vi.spyOn(queueStore, 'playItem').mockResolvedValue()

        await wrapper.findAll('.transcript-timestamp')[1].trigger('click')

        expect(queueStore.pendingSeek).toBeNull()
        expect(queueStore.pendingStart).toEqual({guid: GUID, seconds: 65})
        expect(playItem).toHaveBeenCalledWith(ITEM)
    })

    it('highlights the segment being spoken only while this episode is loaded', async () => {
        const wrapper = await mountOpen()
        const queueStore = useQueueStore()
        queueStore.playbackPosition = 66
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.is-current').exists()).toBe(false)

        queueStore.items = [ITEM]
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.is-current').text()).toBe('One minute in.')
    })
})
