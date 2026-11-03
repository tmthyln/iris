import {introspectWorkflowInstance} from 'cloudflare:test'
import {env, type WorkflowStep} from 'cloudflare:workers'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {createTranscriptRequest} from './crud'
import {ServerFeedItem} from './models'
import {mockFetch, resetStorage, seedFeed, seedFeedItem, testEnv} from './testing/fixtures'
import {buildM4a} from './testing/mp4'
import {DEFAULT_LIMITS, extractAdts, isFrameStream, isMp4, planChunks, runTranscription, serializeSegments, stitchResults, type TranscriptionLimits} from './transcription'

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
 * A fake AI binding. Batch submissions get request ids `req-1`, `req-2`, …;
 * polling a request id answers with the next entry of its script (the last one
 * repeats). Synchronous calls answer with `transcribe(input)`.
 */
function fakeAi(scripts: Record<string, unknown[]> = {}, transcribe: (input: AiInput) => unknown = () => ({text: 'words'})) {
    const submitted: AiInput[] = []
    const polls: Record<string, number> = {}
    const run = vi.fn((_model: string, input: AiInput, options?: {queueRequest?: boolean}) => {
        if (input.request_id === undefined && !options?.queueRequest) {
            const answer = transcribe(input)
            return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
        }
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
        .first<{status: string, error_message: string | null, started_at: string | null, completed_at: string | null, text: string | null, segments_json: string | null, language: string | null, chunks_done: number, chunks_total: number | null}>())!
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

describe('isMp4', () => {
    test('recognises the ftyp box, not other formats', () => {
        expect(isMp4(buildM4a({frames: [new Uint8Array(1)]}))).toBe(true)
        expect(isMp4(new Uint8Array(MP3_FRAME))).toBe(false)
        expect(isMp4(new TextEncoder().encode('RIFF....WAVE'))).toBe(false)
        expect(isMp4(new Uint8Array(4))).toBe(false)
    })
})

describe('planChunks', () => {
    const limits: TranscriptionLimits = {...DEFAULT_LIMITS, chunkBytes: 100, overlapBytes: 10, batchMaxBytes: 500}

    test('keeps a file up to a quarter over the chunk size in one request', () => {
        expect(planChunks({size: 125, splittable: true}, limits)).toEqual([{offset: 0, length: 125}])
    })

    test('splits a larger frame-based file into overlapping ranges covering every byte', () => {
        expect(planChunks({size: 250, splittable: true}, limits)).toEqual([
            {offset: 0, length: 94},
            {offset: 84, length: 94},
            {offset: 168, length: 82},
        ])
    })

    test('bounds chunks by duration when it is known, so low-bitrate audio is not hours long', () => {
        // 6 KiB/s, as 48 kbit/s HE-AAC is: 330 seconds is under 2 MiB
        const ranges = planChunks({size: 30 * MIB, splittable: true, seconds: 5243}, DEFAULT_LIMITS)
        expect(ranges).toHaveLength(16)
        expect(ranges[0].offset).toBe(0)
        expect(ranges[1].offset - ranges[0].offset).toBeLessThanOrEqual(2 * MIB)
        // 16 seconds of overlap
        expect(ranges[0].length - ranges[1].offset).toBe(Math.ceil(16 * 30 * MIB / 5243))
        expect(ranges[15].offset + ranges[15].length).toBe(30 * MIB)
    })

    test('still bounds high-bitrate audio of a known duration by size', () => {
        // 32 KiB/s, as 256 kbit/s AAC is
        const ranges = planChunks({size: 32 * MIB, splittable: true, seconds: 1024}, DEFAULT_LIMITS)
        expect(ranges).toHaveLength(7)
        expect(ranges[1].offset).toBeLessThanOrEqual(5 * MIB)
        expect(ranges[0].length - ranges[1].offset).toBe(MIB / 4)
    })

    test('keeps a short episode of a known duration in one request', () => {
        expect(planChunks({size: MIB, splittable: true, seconds: 170}, DEFAULT_LIMITS)).toEqual([{offset: 0, length: MIB}])
    })

    test('sends other formats whole, up to the batch limit', () => {
        expect(planChunks({size: 500, splittable: false}, limits)).toEqual([{offset: 0, length: 500}])
    })

    test('refuses to split other formats', () => {
        expect(() => planChunks({size: 30 * MIB, splittable: false}, DEFAULT_LIMITS))
            .toThrow('Audio is 30 MB; only MP3 and AAC audio can be split, and other formats are limited to 25 MB')
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

    test('keeps segment starts in order when Whisper jitters them', () => {
        const {segments} = stitchResults([{text: '', segments: [{start: 60, end: 62}, {start: 55, end: 57}, {start: 63, end: 64}]}])
        expect(segments?.map(segment => segment.start)).toEqual([60, 60, 63])
    })

    test('reports the language most chunks were detected as', () => {
        const chunk = (language: string) => ({text: '', transcription_info: {language}})
        expect(stitchResults([chunk('en'), chunk('zh'), chunk('zh')]).language).toBe('zh')
    })

    test('estimates a missing duration from the chunk size at the rate of the others', () => {
        const stitched = stitchResults([
            {text: 'one', transcription_info: {duration: 100}, segments: [{start: 0, end: 90}]},
            // VAD trimmed its trailing silence, so its last segment ends early
            {text: 'two', segments: [{start: 0, end: 20}]},
            {text: 'three', transcription_info: {duration: 25}, segments: [{start: 5, end: 6}]},
        ], [{offset: 0, length: 1000}, {offset: 1000, length: 500}, {offset: 1500, length: 250}])

        expect(stitched.segments).toEqual([{start: 0, end: 90}, {start: 100, end: 120}, {start: 155, end: 156}])
    })

    describe('overlapping chunks', () => {
        // 110 seconds of audio each, the last 10 shared with the next chunk.
        const ranges = [{offset: 0, length: 110}, {offset: 100, length: 110}, {offset: 200, length: 50}]
        const info = {transcription_info: {duration: 110, language: 'en'}}

        test('switches chunks mid-overlap, dropping the garbled audio around each cut', () => {
            const stitched = stitchResults([
                {...info, text: 'unused', segments: [
                    {start: 0, end: 99, text: ' before the seam'},
                    {start: 99, end: 104, text: ' across the seam'},
                    {start: 108, end: 110, text: ' 엄마 garbled end'},
                ]},
                {...info, text: 'unused', segments: [
                    {start: 0, end: 1, text: ' garbled start'},
                    {start: 1, end: 4, text: ' seam again'},
                    {start: 4, end: 50, text: ' after the seam'},
                ]},
            ], ranges)

            expect(stitched.text).toBe('before the seam across the seam after the seam')
            expect(stitched.segments).toEqual([
                {start: 0, end: 99, text: ' before the seam'},
                {start: 99, end: 104, text: ' across the seam'},
                {start: 104, end: 150, text: ' after the seam'},
            ])
        })

        test('tolerates a next segment starting just before the last kept one ends', () => {
            const {segments} = stitchResults([
                {...info, text: '', segments: [{start: 100, end: 104.2, text: ' a'}]},
                {...info, text: '', segments: [{start: 4, end: 8, text: ' b'}]},
            ], ranges)
            expect(segments?.map(segment => segment.text)).toEqual([' a', ' b'])
        })

        test('recovers the words of a next segment straddling the last kept one', () => {
            const {text, segments} = stitchResults([
                {...info, text: '', segments: [{start: 95, end: 102, text: ' those tells have become'}]},
                {...info, text: '', segments: [{start: 0, end: 5, text: ' tells have become harder to detect', words: [
                    {word: ' have', start: 0, end: 1},
                    {word: ' become', start: 1, end: 2},
                    {word: ' harder', start: 2, end: 3},
                    {word: ' to', start: 3, end: 4},
                    {word: ' detect', start: 4, end: 5},
                ]}]},
            ], ranges)

            expect(text).toBe('those tells have become harder to detect')
            expect(segments?.[1]).toMatchObject({start: 102, end: 105, text: ' harder to detect'})
            expect(segments?.[1].words?.map(word => word.start)).toEqual([102, 103, 104])
        })

        test('still shifts later chunks when one has no speech', () => {
            const stitched = stitchResults([
                {...info, text: 'first', segments: [{start: 1, end: 2, text: ' first'}]},
                {...info, text: ' ', segments: []},
                {text: 'third', transcription_info: {duration: 50}, segments: [{start: 6, end: 7, text: ' third'}]},
            ], ranges)
            expect(stitched.text).toBe('first third')
            expect(stitched.segments?.map(segment => segment.start)).toEqual([1, 206])
        })

        test('leaves out a final chunk with no speech', () => {
            const stitched = stitchResults([
                {...info, text: 'unused', segments: [{start: 1, end: 2, text: ' first'}]},
                {...info, text: 'unused', segments: [{start: 3, end: 4, text: ' second.'}]},
                {text: ' .,', transcription_info: {duration: 50}, segments: [{start: 0.6, end: 1, text: ' .,'}]},
            ], ranges)

            expect(stitched.text).toBe('first second.')
            expect(stitched.segments?.map(segment => segment.text)).toEqual([' first', ' second.'])
        })

        test('still shifts later chunks past a chunk in the middle with no speech', () => {
            const stitched = stitchResults([
                {...info, text: 'unused', segments: [{start: 1, end: 2, text: ' first'}]},
                {...info, text: ' .,', segments: [{start: 0.6, end: 1, text: ' .,'}]},
                {text: 'unused', transcription_info: {duration: 50}, segments: [{start: 6, end: 7, text: ' third'}]},
            ], ranges)

            expect(stitched.text).toBe('first third')
            expect(stitched.segments).toEqual([{start: 1, end: 2, text: ' first'}, {start: 206, end: 207, text: ' third'}])
        })

        test('takes a chunk\'s text from its full text after a first chunk with no speech', () => {
            const stitched = stitchResults([
                {...info, text: '.,?!', segments: [{start: 0.6, end: 1, text: '.,?!'}]},
                {text: 'second', transcription_info: {duration: 110}, segments: [{start: 12, end: 13, text: ' second'}]},
            ], ranges.slice(0, 2))

            expect(stitched.text).toBe('second')
            expect(stitched.segments).toEqual([{start: 112, end: 113, text: ' second'}])
        })

        test('does not repeat a chunk whose speech was all in the overlap', () => {
            const {text} = stitchResults([
                {...info, text: 'unused', segments: [{start: 95, end: 104, text: ' said once'}]},
                {text: ' said once .,', transcription_info: {duration: 50}, segments: [
                    {start: 0, end: 4, text: ' said once'},
                    {start: 30, end: 31, text: ' .,'},
                ]},
            ], ranges.slice(0, 2))

            expect(text).toBe('said once')
        })

        test('ends a partial transcript at the cut into the chunk not yet transcribed', () => {
            const {segments} = stitchResults([
                {...info, text: '', segments: [{start: 90, end: 95, text: ' kept'}, {start: 106, end: 108, text: ' dropped'}]},
            ], ranges)
            expect(segments?.map(segment => segment.text)).toEqual([' kept'])
        })
    })

    describe('a single chunk, whose text is not trimmed to its segments', () => {
        test('yields nothing when it has no speech', () => {
            const silent = {text: ' .,', transcription_info: {duration: 30}}
            const empty = {text: '', segments: null, language: null}
            expect(stitchResults([{...silent, segments: [{start: 0.6, end: 1, text: ' .,'}]}])).toEqual(empty)
            expect(stitchResults([silent])).toEqual(empty)
        })

        test('leaves out a segment with no speech at the end of real speech', () => {
            const {text, segments} = stitchResults([{text: ' Goodbye. .,', segments: [
                {start: 0, end: 1, text: ' Goodbye.'},
                {start: 5, end: 6, text: ' .,'},
            ]}])
            expect(text).toBe('Goodbye.')
            expect(segments?.map(segment => segment.text)).toEqual([' Goodbye.'])
        })

        test.each([
            ' Wait... what?!',
            ' 你好。',
            ' 1, 2.',
            ' ♪',
        ])('keeps %j as it is', speech => {
            const {text, segments} = stitchResults([{text: speech, segments: [{start: 0, end: 1, text: speech}]}])
            expect(text).toBe(speech.trim())
            expect(segments?.map(segment => segment.text)).toEqual([speech])
        })
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

describe('extractAdts', () => {
    const KEY = 'transcribe/1/audio'
    const TARGET = 'transcribe/1/audio.aac'

    async function store(file: Uint8Array) {
        await env.RSS_CACHE_BUCKET.put(KEY, file)
        return {key: KEY, size: file.byteLength, splittable: false, mp4: true}
    }

    async function extracted() {
        return new Uint8Array(await (await env.RSS_CACHE_BUCKET.get(TARGET))!.arrayBuffer())
    }

    test('gives every frame a header, wherever the index is', async () => {
        const frames = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
        for (const moovAtEnd of [false, true]) {
            const source = await store(buildM4a({frames, moovAtEnd, ticksPerFrame: 22050, timescale: 44100}))

            const audio = await extractAdts(env, source, TARGET, DEFAULT_LIMITS)

            expect(audio).toEqual({key: TARGET, size: 19, splittable: true, adts: true, seconds: 1})
            expect([...await extracted()]).toEqual([
                0xFF, 0xF1, 0x50, 0x80, 0x01, 0x5F, 0xFC, 1, 2, 3,
                0xFF, 0xF1, 0x50, 0x80, 0x01, 0x3F, 0xFC, 4, 5,
            ])
        }
    })

    test('carries an episode bigger than a buffer across R2 parts and reads', {timeout: 30000}, async () => {
        const frames = Array.from({length: 13 * 1024}, (_, i) => new Uint8Array(1024).fill(i % 251))
        const source = await store(buildM4a({frames, moovAtEnd: true, chunkRuns: [[1, 100]], gapBytes: 1}))
        const limits = {...DEFAULT_LIMITS, partBytes: 5 * MIB}

        const audio = await extractAdts(env, source, TARGET, limits)

        expect(audio?.size).toBe(13 * 1024 * (1024 + 7))
        const stream = await extracted()
        expect(stream.byteLength).toBe(audio?.size)
        for (const i of [0, 1, 5000, 5081, 13 * 1024 - 1]) {
            const start = i * (1024 + 7)
            expect([stream[start], stream[start + 1]]).toEqual([0xFF, 0xF1])
            expect(stream[start + 7]).toBe(i % 251)
            expect(stream[start + 7 + 1023]).toBe(i % 251)
        }
    })

    test('answers null for a file it cannot read, leaving nothing behind', async () => {
        const unusable = [
            buildM4a({frames: [new Uint8Array(4)], codec: 'alac'}),
            buildM4a({frames: [new Uint8Array(4)], fragmented: true}),
            new TextEncoder().encode('\0\0\0\x08ftypnot really an mp4'),
        ]
        for (const file of unusable) {
            expect(await extractAdts(env, await store(file), TARGET, DEFAULT_LIMITS)).toBeNull()
        }
        expect(await env.RSS_CACHE_BUCKET.head(TARGET)).toBeNull()
    })

    test('answers null for an index pointing past the end of the file', async () => {
        const file = buildM4a({frames: [new Uint8Array(4), new Uint8Array(4)]})
        const source = {...await store(file), size: file.byteLength - 2}

        expect(await extractAdts(env, source, TARGET, DEFAULT_LIMITS)).toBeNull()
        expect(await env.RSS_CACHE_BUCKET.head(TARGET)).toBeNull()
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

    test('transcribes an episode that cannot be split through one batch request', async () => {
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
            expect.objectContaining({audio: btoa('audio-bytes'), task: 'transcribe', vad_filter: true}),
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
            'start', 'download audio', 'record plan', 'submit batch',
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

    test('recognises a finished batch request answering with the bare Whisper result', async () => {
        await seedItemWithAudio()
        const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
        mockFetch({[AUDIO_URL]: new Response('audio-bytes')})
        const segments = [{start: 0, end: 1, text: 'bare words'}]
        const ai = fakeAi({'req-1': [
            {status: 'queued', request_id: 'req-1'},
            {status: 'running', request_id: 'req-1'},
            // the shape Workers AI really answers with
            {transcription_info: {language: 'en', duration: 1}, text: 'bare words', word_count: 2, segments, vtt: 'WEBVTT', meta: {}},
        ]})

        await runTranscription(transcript.id, transcribeEnv(ai), fakeStep().step)

        expect(await transcriptRow(transcript.id)).toMatchObject({status: 'complete', text: 'bare words', language: 'en', chunks_done: 1, chunks_total: 1})
    })

    test('transcribes a small MP3 in one synchronous request', async () => {
        await seedItemWithAudio()
        const transcript = await createTranscriptRequest(db, 'ep-1', MODEL, 'de')
        const bytes = id3Tagged(MP3_FRAME)
        mockFetch({[AUDIO_URL]: new Response(bytes)})
        const ai = fakeAi({}, () => ({text: 'short', segments: [{start: 0, end: 1, text: 'short'}], vtt: 'WEBVTT'}))
        const {names, step} = fakeStep()

        await runTranscription(transcript.id, transcribeEnv(ai), step)

        expect(ai.run).toHaveBeenCalledExactlyOnceWith(MODEL, expect.objectContaining({audio: Buffer.from(bytes).toString('base64'), task: 'transcribe', language: 'de', vad_filter: true}))
        expect(names).toEqual(['start', 'download audio', 'record plan', 'transcribe chunk 1', 'persist transcript', 'index transcript', 'clean up'])
        expect(await transcriptRow(transcript.id)).toMatchObject({status: 'complete', text: 'short', language: 'de', chunks_done: 1, chunks_total: 1})
    })

    describe('an M4A', () => {
        const M4A_URL = 'https://cdn.example.com/episode.m4a'

        async function start(file: Uint8Array) {
            await seedItemWithAudio(M4A_URL)
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            mockFetch({[M4A_URL]: new Response(file)})
            return transcript
        }

        test('is transcribed synchronously from its AAC frames, in overlapping chunks on frame boundaries', async () => {
            // A second per frame of 100 bytes: chunks of 40 seconds, 40 frames, overlapping by 4.
            const frames = Array.from({length: 250}, () => new Uint8Array(93).fill(0x11))
            const transcript = await start(buildM4a({frames, moovAtEnd: true, timescale: 1024}))
            const limits = {...DEFAULT_LIMITS, chunkSeconds: 40, overlapSeconds: 4}
            const audios: string[] = []
            const ai = fakeAi({}, input => {
                audios.push(decode(input.audio))
                return {text: `chunk ${audios.length}`, transcription_info: {duration: 40}, segments: [{start: 1, end: 2, text: `chunk ${audios.length}`}]}
            })
            const {names, step} = fakeStep()

            await runTranscription(transcript.id, transcribeEnv(ai), step, limits)

            expect(ai.submitted).toEqual([])
            expect(audios).toHaveLength(7)
            for (const audio of audios) {
                expect(audio.charCodeAt(0)).toBe(0xFF)
                expect(audio.charCodeAt(1)).toBe(0xF1)
            }
            expect(names.slice(0, 4)).toEqual(['start', 'download audio', 'extract AAC frames', 'record plan'])
            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'complete', chunks_done: 7, chunks_total: 7})
            expect(await workingFiles()).toEqual([])
        })

        test('falls back to a batch request if its track cannot be extracted', async () => {
            const transcript = await start(buildM4a({frames: [new Uint8Array(4)], fragmented: true}))
            const ai = fakeAi({'req-1': [done('fragmented words')]})
            const {names, step} = fakeStep()

            await runTranscription(transcript.id, transcribeEnv(ai), step)

            expect(ai.submitted).toHaveLength(1)
            expect(names).toContain('extract AAC frames')
            expect(names).toContain('submit batch')
            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'complete', text: 'fragmented words'})
            expect(await workingFiles()).toEqual([])
        })

        test('fails with a clear message if it is too long for that', async () => {
            const transcript = await start(buildM4a({frames: [new Uint8Array(100)], codec: 'alac'}))
            const limits = {...DEFAULT_LIMITS, batchMaxBytes: 10}

            await runTranscription(transcript.id, transcribeEnv(), fakeStep().step, limits)

            expect((await transcriptRow(transcript.id)).error_message).toContain('only MP3 and AAC audio can be split')
        })
    })

    test('moves the cut in a raw ADTS file to the next frame', async () => {
        const frame = (fill: number) => [0xFF, 0xF1, 0x50, 0x80, 0x01, 0x3F, 0xFC, fill, fill]
        const bytes = new Uint8Array(Array.from({length: 40}, (_, i) => frame(i)).flat())
        await seedItemWithAudio()
        const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
        mockFetch({[AUDIO_URL]: new Response(bytes)})
        const audios: string[] = []
        const ai = fakeAi({}, input => {
            audios.push(decode(input.audio))
            return {text: 'words', transcription_info: {duration: 1}}
        })
        const limits = {...DEFAULT_LIMITS, chunkBytes: 100, overlapBytes: 10}

        await runTranscription(transcript.id, transcribeEnv(ai), fakeStep().step, limits)

        expect(audios.length).toBeGreaterThan(1)
        for (const audio of audios) expect(audio.charCodeAt(0)).toBe(0xFF)
    })

    describe('a long MP3', () => {
        // Chunks of 36 bytes overlapping by 4: each is 40 seconds at a second per byte.
        const LIMITS = {...DEFAULT_LIMITS, chunkBytes: 40, overlapBytes: 4, concurrency: 2}
        const bytes = id3Tagged([...MP3_FRAME, ...new TextEncoder().encode('abcdefghij'.repeat(19))])  // 208 bytes
        const audio = String.fromCharCode(...bytes)

        async function start() {
            await seedItemWithAudio()
            const transcript = await createTranscriptRequest(db, 'ep-1', MODEL)
            mockFetch({[AUDIO_URL]: new Response(bytes)})
            return transcript
        }

        /** Answers each chunk with one segment naming it, at the chunk's own second 1. */
        function chunkAi() {
            const inputs: string[] = []
            const ai = fakeAi({}, input => {
                const chunk = inputs.push(decode(input.audio))
                return {
                    text: `chunk ${chunk}`,
                    transcription_info: {language: 'en', duration: decode(input.audio).length},
                    segments: [{start: 1, end: 2, text: ` chunk ${chunk}`}],
                }
            })
            return {ai, inputs}
        }

        test('transcribes overlapping chunks in groups and stitches them', async () => {
            const transcript = await start()
            const {ai, inputs} = chunkAi()
            const {names, step} = fakeStep()

            await runTranscription(transcript.id, transcribeEnv(ai), step, LIMITS)

            expect(inputs).toEqual([0, 1, 2, 3, 4, 5].map(i => audio.slice(i * 35, i * 35 + 39)))
            expect(names).toEqual([
                'start', 'download audio', 'record plan',
                'transcribe chunk 1', 'transcribe chunk 2', 'publish 2 chunks',
                'transcribe chunk 3', 'transcribe chunk 4', 'publish 4 chunks',
                'transcribe chunk 5', 'transcribe chunk 6',
                'persist transcript', 'index transcript', 'clean up',
            ])
            const row = await transcriptRow(transcript.id)
            expect(row).toMatchObject({status: 'complete', text: 'chunk 1 chunk 2 chunk 3 chunk 4 chunk 5 chunk 6', language: 'en', chunks_done: 6, chunks_total: 6})
            expect((JSON.parse(row.segments_json!) as {start: number}[]).map(segment => segment.start)).toEqual([1, 36, 71, 106, 141, 176])
            expect(await workingFiles()).toEqual([])
        })

        test('publishes the partial transcript after each group', async () => {
            const transcript = await start()
            const {ai} = chunkAi()
            const {step} = fakeStep()
            const seen: unknown[] = []
            const realDo = step.do.bind(step) as (name: string, ...rest: unknown[]) => Promise<unknown>
            step.do = (async (name: string, ...rest: unknown[]) => {
                const result = await realDo(name, ...rest)
                if (name.startsWith('publish')) {
                    const row = await transcriptRow(transcript.id)
                    seen.push({status: row.status, text: row.text, chunks_done: row.chunks_done, segments: (JSON.parse(row.segments_json!) as unknown[]).length})
                }
                return result
            }) as typeof step.do

            await runTranscription(transcript.id, transcribeEnv(ai), step, LIMITS)

            expect(seen).toEqual([
                {status: 'processing', text: 'chunk 1 chunk 2', chunks_done: 2, segments: 2},
                {status: 'processing', text: 'chunk 1 chunk 2 chunk 3 chunk 4', chunks_done: 4, segments: 4},
            ])
        })

        test('a failing chunk fails the transcript but keeps what was published', async () => {
            const transcript = await start()
            vi.spyOn(console, 'error').mockImplementation(() => {})
            let calls = 0
            const ai = fakeAi({}, () => ++calls === 4
                ? new Error('capacity')
                : {text: `chunk ${calls}`, transcription_info: {duration: 39}, segments: [{start: 1, end: 2, text: ` chunk ${calls}`}]})

            await runTranscription(transcript.id, transcribeEnv(ai), fakeStep().step, LIMITS)

            expect(calls).toBe(4)  // the other chunk of the group finished; no later group started
            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'error', error_message: 'capacity', text: 'chunk 1 chunk 2', chunks_done: 2, chunks_total: 6})
            expect(await workingFiles()).toEqual([])
        })

        test('a response without text fails the chunk', async () => {
            const transcript = await start()
            vi.spyOn(console, 'error').mockImplementation(() => {})
            const ai = fakeAi({}, () => ({errors: ['nope']}))

            await runTranscription(transcript.id, transcribeEnv(ai), fakeStep().step, LIMITS)

            expect(await transcriptRow(transcript.id)).toMatchObject({status: 'error', error_message: 'Whisper returned no text'})
        })
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
            const message = await failingRun(new Response('\0\0\0 ftypM4A ' + 'x'.repeat(100)), ai, {batchMaxBytes: 40})
            expect(message).toContain('only MP3 and AAC audio can be split')
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
