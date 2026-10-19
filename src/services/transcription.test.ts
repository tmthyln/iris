import {introspectWorkflowInstance} from 'cloudflare:test'
import {env, type WorkflowStep} from 'cloudflare:workers'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {createTranscriptRequest} from './crud'
import {ServerFeedItem} from './models'
import {mockFetch, resetStorage, seedFeed, seedFeedItem, testEnv} from './testing/fixtures'
import {DEFAULT_LIMITS, isFrameStream, planChunks, runTranscription, serializeSegments, stitchResults, type TranscriptionLimits} from './transcription'

const db = env.DB

beforeEach(() => resetStorage())
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const MODEL = '@cf/openai/whisper-large-v3-turbo'
const AUDIO_URL = 'https://cdn.example.com/episode.mp3'
const MIB = 1024 * 1024

/** Runs every step inline, once, and never sleeps; records the step names in order. */
function fakeStep() {
    const names: string[] = []
    const step = {
        do: (name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) => {
            names.push(name)
            return (callback ?? configOrCallback as () => Promise<unknown>)()
        },
        sleep: (name: string) => {
            names.push(name)
            return Promise.resolve()
        },
    }
    return {names, step: step as unknown as WorkflowStep}
}

type AiInput = {audio?: string, request_id?: string, language?: string}

/**
 * A fake AI binding: submissions get request ids `req-1`, `req-2`, …; polling
 * a request id answers with the next entry of its script (the last one repeats).
 */
function fakeAi(scripts: Record<string, unknown[]> = {}) {
    const submitted: AiInput[] = []
    const polls: Record<string, number> = {}
    const run = vi.fn((_model: string, input: AiInput) => {
        if (input.request_id === undefined) {
            submitted.push(input)
            return Promise.resolve({request_id: `req-${submitted.length}`, status: 'queued'})
        }
        const script = scripts[input.request_id] ?? [{status: 'queued'}]
        const turn = polls[input.request_id] ?? 0
        polls[input.request_id] = turn + 1
        const answer = script[Math.min(turn, script.length - 1)]
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    })
    return {run, submitted}
}

function done(text: string, extra: Record<string, unknown> = {}) {
    return {status: 'complete', responses: [{success: true, result: {text, ...extra}}]}
}

function transcribeEnv(ai = fakeAi()) {
    return testEnv({AI: ai as unknown as Ai}).env
}

async function seedItemWithAudio(enclosureUrl: string | null = AUDIO_URL) {
    await seedFeed({guid: 'feed-a', type: 'podcast'})
    return seedFeedItem('feed-a', {guid: 'ep-1', enclosure_url: enclosureUrl, encoded_content: '<p>Show notes</p>'})
}

async function transcriptRow(id: number) {
    return (await db.prepare('SELECT * FROM transcript WHERE id = ?').bind(id)
        .first<{status: string, error_message: string | null, started_at: string | null, completed_at: string | null, text: string | null, segments_json: string | null, language: string | null}>())!
}

async function workingFiles() {
    return (await env.RSS_CACHE_BUCKET.list({prefix: 'transcribe/'})).objects.map(object => object.key)
}

function decode(base64: string | undefined) {
    return atob(base64 ?? '')
}

// An MPEG-1 Layer III frame header (128 kbit/s, 44.1 kHz).
const MP3_FRAME = [0xFF, 0xFB, 0x90, 0x64]

/** An ID3v2 tag of `tagBytes` (after its 10-byte header), then `rest`. */
function id3Tagged(rest: number[], tagBytes = 4) {
    const size = [21, 14, 7, 0].map(shift => (tagBytes >> shift) & 0x7F)
    return new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, ...size, ...new Array<number>(tagBytes).fill(0), ...rest])
}

describe('isFrameStream', () => {
    test('accepts MP3 and ADTS AAC frames, after an ID3 tag or not', () => {
        expect(isFrameStream(new Uint8Array(MP3_FRAME))).toBe(true)
        expect(isFrameStream(new Uint8Array([0xFF, 0xF1, 0x50, 0x80]))).toBe(true)  // ADTS
        expect(isFrameStream(id3Tagged(MP3_FRAME))).toBe(true)
        expect(isFrameStream(id3Tagged(MP3_FRAME, 300))).toBe(true)  // a tag over 127 bytes uses the synchsafe encoding
    })

    test('rejects other formats even behind an ID3 tag', () => {
        const flac = [0x66, 0x4C, 0x61, 0x43]  // "fLaC"
        expect(isFrameStream(new Uint8Array(flac))).toBe(false)
        expect(isFrameStream(id3Tagged(flac))).toBe(false)
        expect(isFrameStream(new TextEncoder().encode('\0\0\0 ftypM4A '))).toBe(false)
        expect(isFrameStream(new Uint8Array([0xFF, 0xE9, 0x90, 0x64]))).toBe(false)  // reserved MPEG version
    })

    test('treats a tag running past the probed bytes as unsplittable', () => {
        expect(isFrameStream(id3Tagged(MP3_FRAME).subarray(0, 12))).toBe(false)
        expect(isFrameStream(new Uint8Array([0x49, 0x44, 0x33]))).toBe(false)
        expect(isFrameStream(new Uint8Array())).toBe(false)
    })
})

describe('planChunks', () => {
    const limits: TranscriptionLimits = {...DEFAULT_LIMITS, chunkBytes: 100}

    test('keeps a file up to a quarter over the chunk size in one request', () => {
        expect(planChunks({size: 125, splittable: false}, limits)).toEqual([{offset: 0, length: 125}])
    })

    test('splits a larger frame-based file into equal ranges covering every byte', () => {
        expect(planChunks({size: 250, splittable: true}, limits)).toEqual([
            {offset: 0, length: 84},
            {offset: 84, length: 84},
            {offset: 168, length: 82},
        ])
    })

    test('refuses to split other formats', () => {
        expect(() => planChunks({size: 30 * MIB, splittable: false}, DEFAULT_LIMITS))
            .toThrow('Audio is 30 MB; only MP3 audio can be split, and other formats are limited to 25 MB')
    })
})

describe('stitchResults', () => {
    test('offsets each chunk by the duration of the audio before it', () => {
        const stitched = stitchResults([
            {
                text: ' first part ',
                transcription_info: {language: 'fr', duration: 100},
                segments: [{start: 0, end: 4, words: [{start: 0, end: 1}]}, {start: 4, end: 90}],
            },
            // no reported duration and no chunk sizes: the end of its last segment
            {text: 'second part', segments: [{start: 1, end: 50}]},
            {text: 'third part', transcription_info: {language: 'en'}, segments: [{start: 2, end: 3, words: [{start: 2, end: 3}]}]},
        ])

        expect(stitched).toEqual({
            text: 'first part second part third part',
            language: 'fr',
            segments: [
                {start: 0, end: 4, words: [{start: 0, end: 1}]},
                {start: 4, end: 90},
                {start: 101, end: 150},
                {start: 152, end: 153, words: [{start: 152, end: 153}]},
            ],
        })
    })

    test('estimates a missing duration from the chunk size at the rate of the others', () => {
        const stitched = stitchResults([
            {text: 'one', transcription_info: {duration: 100}, segments: [{start: 0, end: 90}]},
            // VAD trimmed its trailing silence, so its last segment ends early
            {text: 'two', segments: [{start: 0, end: 20}]},
            {text: 'three', transcription_info: {duration: 25}, segments: [{start: 5, end: 6}]},
        ], [1000, 500, 250])

        expect(stitched.segments).toEqual([{start: 0, end: 90}, {start: 100, end: 120}, {start: 155, end: 156}])
    })

    test('yields no segments when the model returned none', () => {
        expect(stitchResults([{text: 'words'}])).toEqual({text: 'words', segments: null, language: null})
    })
})

describe('serializeSegments', () => {
    const segments = [{start: 0, end: 1, text: 'hello', words: [{start: 0, end: 1}]}]

    test('keeps everything that fits', () => {
        expect(serializeSegments(null)).toBeNull()
        expect(serializeSegments(segments)).toBe(JSON.stringify(segments))
    })

    test('drops word timestamps, then the segments, to stay within the limit', () => {
        expect(serializeSegments(segments, 50)).toBe(JSON.stringify([{start: 0, end: 1, text: 'hello'}]))
        expect(serializeSegments(segments, 10)).toBeNull()
    })
})

describe('runTranscription', () => {
    test('ignores unknown ids and finished transcripts', async () => {
        await seedItemWithAudio()
        const ai = fakeAi()
        const {fetchMock} = mockFetch({})

        await runTranscription(999, transcribeEnv(ai), fakeStep().step)
        for (const status of ['complete', 'error']) {
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            await db.prepare('UPDATE transcript SET status = ? WHERE id = ?').bind(status, transcript.id).run()
            await runTranscription(transcript.id, transcribeEnv(ai), fakeStep().step)
            expect((await transcriptRow(transcript.id)).status).toBe(status)
        }

        expect(fetchMock).not.toHaveBeenCalled()
        expect(ai.run).not.toHaveBeenCalled()
    })

    test('fails a transcript whose item has no enclosure', async () => {
        await seedItemWithAudio(null)
        const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
        const {names, step} = fakeStep()

        await runTranscription(transcript.id, transcribeEnv(), step)

        expect(await transcriptRow(transcript.id)).toMatchObject({
            status: 'error',
            error_message: 'Feed item has no enclosure_url',
            completed_at: expect.any(String) as string,
        })
        expect(names).toEqual(['start', 'record failure', 'clean up'])
    })

    test('transcribes a short episode in one request', async () => {
        const item = await seedItemWithAudio()
        const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
        const {calls} = mockFetch({[AUDIO_URL]: new Response('audio-bytes')})
        const segments = [{start: 0, end: 1, text: 'spoken words'}]
        const ai = fakeAi({'req-1': [
            {status: 'queued'},
            new Error('network'),
            done('spoken words', {transcription_info: {language: 'fr'}, segments}),
        ]})
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const {names, step} = fakeStep()

        await runTranscription(transcript.id, transcribeEnv(ai), step)

        expect(calls[0].headers.get('User-Agent')).toContain('Iris')
        expect(ai.run).toHaveBeenCalledWith(
            MODEL,
            {audio: btoa('audio-bytes'), task: 'transcribe', vad_filter: true},
            {queueRequest: true},
        )
        expect(ai.run).toHaveBeenCalledWith(MODEL, {request_id: 'req-1'})
        // a failed poll counts as "not ready yet"
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Polling a Whisper batch request failed; will retry',
            batchRequestId: 'req-1',
            error: expect.objectContaining({message: 'network'}),
        }))
        expect(names).toEqual([
            'start', 'download audio', 'submit chunk 1',
            'wait 1', 'poll 1', 'wait 2', 'poll 2', 'wait 3', 'poll 3',
            'persist transcript', 'index transcript', 'clean up',
        ])
        expect(await transcriptRow(transcript.id)).toMatchObject({
            status: 'complete',
            text: 'spoken words',
            segments_json: JSON.stringify(segments),
            language: 'fr',
            error_message: null,
            started_at: expect.any(String) as string,
            completed_at: expect.any(String) as string,
        })
        const indexed = await db.prepare('SELECT content FROM text_search WHERE guid = ?').bind(item.guid).first<{content: string}>()
        expect(indexed!.content).toBe('Show notes\n\nspoken words')
        expect(await workingFiles()).toEqual([])
    })

    test('passes the requested language through and keeps it when none is detected', async () => {
        await seedItemWithAudio()
        const transcript = await createTranscriptRequest(db, 'ep-1', MODEL, 'de')
        mockFetch({[AUDIO_URL]: new Response('audio-bytes')})
        // an inline (non-`responses`) result
        const ai = fakeAi({'req-1': [{result: {text: 'inline words'}}]})

        await runTranscription(transcript.id, transcribeEnv(ai), fakeStep().step)

        expect(ai.submitted[0].language).toBe('de')
        expect(await transcriptRow(transcript.id)).toMatchObject({status: 'complete', text: 'inline words', segments_json: null, language: 'de'})
    })

    test('splits a long MP3 into chunks and stitches the timestamps', async () => {
        await seedItemWithAudio()
        const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
        const bytes = id3Tagged([...MP3_FRAME, ...new TextEncoder().encode('abcdefghij'.repeat(9))])  // 108 bytes
        const audio = String.fromCharCode(...bytes)
        mockFetch({[AUDIO_URL]: new Response(bytes)})
        const ai = fakeAi({
            'req-1': [done('one', {transcription_info: {language: 'en', duration: 60}, segments: [{start: 0, end: 59, text: 'one'}]})],
            // the second chunk finishes a round after the others
            'req-2': [{status: 'running'}, done('two', {transcription_info: {duration: 60}, segments: [{start: 1, end: 58, text: 'two'}]})],
            'req-3': [done('three', {transcription_info: {duration: 30}, segments: [{start: 2, end: 29, text: 'three'}]})],
        })
        const {names, step} = fakeStep()

        await runTranscription(transcript.id, transcribeEnv(ai), step, {...DEFAULT_LIMITS, chunkBytes: 40})

        expect(ai.submitted.map(input => decode(input.audio))).toEqual([audio.slice(0, 36), audio.slice(36, 72), audio.slice(72)])
        expect(names).toEqual([
            'start', 'download audio', 'submit chunk 1', 'submit chunk 2', 'submit chunk 3',
            'wait 1', 'poll 1', 'wait 2', 'poll 2',
            'persist transcript', 'index transcript', 'clean up',
        ])
        // finished chunks are not polled again
        expect(ai.run.mock.calls.filter(([, input]) => input.request_id === 'req-1')).toHaveLength(1)
        expect(await transcriptRow(transcript.id)).toMatchObject({
            status: 'complete',
            text: 'one two three',
            language: 'en',
            segments_json: JSON.stringify([
                {start: 0, end: 59, text: 'one'},
                {start: 61, end: 118, text: 'two'},
                {start: 122, end: 149, text: 'three'},
            ]),
        })
        expect(await workingFiles()).toEqual([])
    })

    test('streams a download larger than one R2 part without losing bytes', async () => {
        await seedItemWithAudio()
        const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
        const body = new Uint8Array(6 * MIB + 123)
        for (let i = 0; i < body.byteLength; i += 4099) body[i] = i % 251
        mockFetch({[AUDIO_URL]: new Response(body)})
        const ai = fakeAi({'req-1': [done('words')]})

        await runTranscription(transcript.id, transcribeEnv(ai), fakeStep().step, {...DEFAULT_LIMITS, partBytes: 5 * MIB})

        expect(ai.submitted).toHaveLength(1)
        expect(ai.submitted[0].audio).toBe(Buffer.from(body).toString('base64'))
        expect((await transcriptRow(transcript.id)).status).toBe('complete')
    })

    describe('failures', () => {
        async function failingRun(response: Response, ai = fakeAi(), limits: Partial<TranscriptionLimits> = {}) {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            mockFetch({[AUDIO_URL]: response})
            const {names, step} = fakeStep()

            await runTranscription(transcript.id, transcribeEnv(ai), step, {...DEFAULT_LIMITS, ...limits})

            expect(names.slice(-2)).toEqual(['record failure', 'clean up'])
            expect(await workingFiles()).toEqual([])
            const row = await transcriptRow(transcript.id)
            expect(row).toMatchObject({status: 'error', completed_at: expect.any(String) as string})
            return row.error_message
        }

        test('a failed download', async () => {
            const ai = fakeAi()
            expect(await failingRun(new Response('nope', {status: 500}), ai)).toBe('Upstream fetch failed: HTTP 500')
            expect(ai.run).not.toHaveBeenCalled()
        })

        test('a download the host refuses is not retried', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            mockFetch({[AUDIO_URL]: new Response('gone', {status: 404})})

            await runTranscription(transcript.id, transcribeEnv(), fakeStep().step)

            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'error', error_message: 'Upstream fetch failed: HTTP 404'})
        })

        test('a search index failure leaves the stored transcript complete', async () => {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            mockFetch({[AUDIO_URL]: new Response('audio-bytes')})
            const error = vi.spyOn(console, 'error').mockImplementation(() => {})
            vi.spyOn(ServerFeedItem.prototype, 'refreshTextSearch').mockRejectedValue(new Error('fts broken'))

            await runTranscription(transcript.id, transcribeEnv(fakeAi({'req-1': [done('words')]})), fakeStep().step)

            expect(error).toHaveBeenCalledWith(expect.objectContaining({
                message: 'Refreshing the search index after transcription failed',
                error: expect.objectContaining({message: 'fts broken'}),
            }))
            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'complete', text: 'words', error_message: null})
        })

        test('an episode whose declared size is over the limit', async () => {
            const response = new Response('audio-bytes', {headers: {'Content-Length': '11'}})
            expect(await failingRun(response, fakeAi(), {maxBytes: 10})).toBe('Audio is larger than the 0 MB transcription limit')
        })

        test('an episode that turns out to be over the limit while streaming', async () => {
            const stream = new Response('audio-bytes').body!.pipeThrough(new TransformStream())
            expect(await failingRun(new Response(stream), fakeAi(), {maxBytes: 10})).toBe('Audio is larger than the 0 MB transcription limit')
        })

        test('an empty download', async () => {
            expect(await failingRun(new Response(''))).toBe('Audio download was empty')
        })

        test('a long episode in a format that cannot be split', async () => {
            const ai = fakeAi()
            const message = await failingRun(new Response('\0\0\0 ftypM4A ' + 'x'.repeat(100)), ai, {chunkBytes: 40})
            expect(message).toContain('only MP3 audio can be split')
            expect(ai.run).not.toHaveBeenCalled()
        })

        test('a submission without a request id', async () => {
            const ai = fakeAi()
            ai.run.mockResolvedValue({status: 'queued'})
            expect(await failingRun(new Response('audio-bytes'), ai)).toBe('Batch submission returned no request_id')
        })

        test('a rejected submission', async () => {
            const ai = fakeAi()
            ai.run.mockRejectedValue(new Error('quota exceeded'))
            expect(await failingRun(new Response('audio-bytes'), ai)).toBe('quota exceeded')
        })

        test('an overlong error message is truncated', async () => {
            const ai = fakeAi()
            ai.run.mockRejectedValue(new Error(`Too many redirects. ${'x'.repeat(5000)}`))
            const message = (await failingRun(new Response('audio-bytes'), ai))!
            expect(message).toHaveLength(501)
            expect(message.startsWith('Too many redirects. xxx')).toBe(true)
        })

        test('a failed inference', async () => {
            const withError = fakeAi({'req-1': [{responses: [{success: false, error: {code: 'E1', message: 'bad audio'}}]}]})
            expect(await failingRun(new Response('audio-bytes'), withError)).toBe(JSON.stringify({code: 'E1', message: 'bad audio'}))
        })

        test('a silently failed inference', async () => {
            const silent = fakeAi({'req-1': [{success: false}]})
            expect(await failingRun(new Response('audio-bytes'), silent)).toBe('Inference failed')
        })

        test('a batch that never finishes', async () => {
            const ai = fakeAi()
            expect(await failingRun(new Response('audio-bytes'), ai)).toBe('Timed out waiting for Whisper batch result')
            // one submission plus an hour of polls
            expect(ai.run).toHaveBeenCalledTimes(121)
        })
    })
})

describe('TranscribeWorkflow', () => {
    test('runs the pipeline as a Workflow instance and records a failure on the transcript', async () => {
        await seedItemWithAudio(null)
        const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
        const instanceId = `transcript-test-${crypto.randomUUID()}`
        await using instance = await introspectWorkflowInstance(env.TRANSCRIBE_WORKFLOW, instanceId)

        await env.TRANSCRIBE_WORKFLOW.create({id: instanceId, params: {transcriptId: transcript.id}})
        await instance.waitForStatus('complete')

        expect(await transcriptRow(transcript.id)).toMatchObject({status: 'error', error_message: 'Feed item has no enclosure_url'})
    })

    test('logs under the transcript and the request that started it', async () => {
        await seedItemWithAudio(null)
        const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
        const instanceId = `transcript-test-${crypto.randomUUID()}`
        await using instance = await introspectWorkflowInstance(env.TRANSCRIBE_WORKFLOW, instanceId)
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})

        const trace = {requestId: 'req-1', sessionId: 'sess-1'}
        await env.TRANSCRIBE_WORKFLOW.create({id: instanceId, params: {transcriptId: transcript.id, trace}})
        await instance.waitForStatus('complete')

        expect(error).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Transcription failed',
            reason: 'Feed item has no enclosure_url',
            transcriptId: transcript.id,
            ...trace,
        }))
    })
})
