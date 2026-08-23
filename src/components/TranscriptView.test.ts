import {afterEach, describe, expect, it, vi} from 'vitest'
import {useQueueStore} from '../stores/queue.ts'
import {useTranscriptStore} from '../stores/transcripts.ts'
import {makeFullTranscript, makeItem, makeTranscript, ok, stubClient, mountApp} from '../testing/helpers.ts'
import TranscriptView from './TranscriptView.vue'

afterEach(() => vi.restoreAllMocks())

const GUID = 'item-under-test'

const SEGMENTS = JSON.stringify([
    {start: 0, end: 4, text: 'Hello and welcome.'},
    {start: 65, end: 70, text: 'One minute in.'},
    {start: 3700, end: 3705, text: 'One hour in.'},
])

async function mountTranscripts({transcripts = [makeTranscript({status: 'complete'})], open = false} = {}) {
    const mounted = await mountApp(TranscriptView, {props: {feedItemGuid: GUID, open}})
    useTranscriptStore().byItem[GUID] = transcripts
    await mounted.wrapper.vm.$nextTick()
    return mounted
}

describe('visibility', () => {
    it('renders nothing while there is no completed transcript', async () => {
        const {wrapper} = await mountTranscripts({transcripts: [makeTranscript({status: 'pending'})]})
        expect(wrapper.find('.transcript-view').exists()).toBe(false)
    })

    it('shows a toggle that asks the parent to open', async () => {
        const {wrapper} = await mountTranscripts()
        const toggle = wrapper.find('button')
        expect(toggle.text()).toContain('Transcript')
        expect(wrapper.find('.transcript-body').exists()).toBe(false)

        await toggle.trigger('click')
        expect(wrapper.emitted('update:open')).toEqual([[true]])
    })
})

describe('content', () => {
    it('loads and renders timestamped segments when open', async () => {
        const complete = makeTranscript({status: 'complete'})
        stubClient('getTranscript', ok(makeFullTranscript({id: complete.id, segments_json: SEGMENTS})))
        const {wrapper} = await mountTranscripts({transcripts: [complete], open: true})
        await vi.waitFor(() => expect(wrapper.findAll('.transcript-segment')).toHaveLength(3))

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

    it('offers a picker when several transcripts completed', async () => {
        const first = makeTranscript({status: 'complete', model: 'openai/whisper-large', language: 'en'})
        const second = makeTranscript({status: 'complete', model: 'whisper-tiny'})
        stubClient('getTranscript', ok(makeFullTranscript({id: first.id})))
        const {wrapper} = await mountTranscripts({transcripts: [first, second]})

        const options = wrapper.findAll('option')
        expect(options).toHaveLength(2)
        expect(options[0].text()).toContain('whisper-large · en')
    })
})

describe('seeking', () => {
    it('seeks through the queue store only while this episode is playing', async () => {
        const complete = makeTranscript({status: 'complete'})
        stubClient('getTranscript', ok(makeFullTranscript({id: complete.id, segments_json: SEGMENTS})))
        const {wrapper} = await mountTranscripts({transcripts: [complete], open: true})
        const queueStore = useQueueStore()
        await vi.waitFor(() => expect(wrapper.findAll('.transcript-timestamp')).toHaveLength(3))

        // Not playing: buttons disabled, click does nothing.
        expect(wrapper.find('.transcript-timestamp').attributes('disabled')).toBeDefined()
        await wrapper.findAll('.transcript-timestamp')[1].trigger('click')
        expect(queueStore.pendingSeek).toBeNull()

        // Playing this item: click requests the seek.
        queueStore.items = [makeItem({guid: GUID})]
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.transcript-timestamp').attributes('disabled')).toBeUndefined()
        await wrapper.findAll('.transcript-timestamp')[1].trigger('click')
        expect(queueStore.pendingSeek).toBe(65)
    })
})
