import {Buffer} from "node:buffer";
import {WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig} from "cloudflare:workers";
import {NonRetryableError} from "cloudflare:workflows";
import {updateTranscriptStatus} from "./crud";
import {ServerFeedItem, ServerTranscript} from "./models";
import {FETCH_USER_AGENT} from "./utils/files";
import {log, type TaskTrace, withLogContext} from "./utils/log";
import {ADTS_HEADER_BYTES, adtsHeader, findMoov, firstAdtsFrame, parseAacTrack} from "./utils/mp4";

export const TRANSCRIPT_DEFAULT_MODEL = '@cf/openai/whisper-large-v3-turbo'

const MIB = 1024 * 1024

const POLL_INTERVAL = '30 seconds'
// Whisper batch results are polled every POLL_INTERVAL; an hour in total.
const MAX_POLLS = 120

// Audio longer than this is split where it can be. Whisper takes about a tenth
// of real time however many bytes that is, so low-bitrate audio needs chunks
// of a duration rather than of a size: 5 MiB at 48 kbit/s is 14 minutes.
const CHUNK_SECONDS = 330
const OVERLAP_SECONDS = 16

// Allows for a very long episode: the table of 10 hours of AAC is about 8 MiB.
const MAX_MOOV_BYTES = 64 * MIB

// A chunk takes under a minute; the retries ride out capacity errors.
const CHUNK_STEP_CONFIG = {
    retries: {limit: 5, delay: '10 seconds', backoff: 'exponential'},
    timeout: '3 minutes',
} satisfies WorkflowStepConfig

// D1 caps a row at 2 MB; the stitched segments of a very long episode can exceed it.
const MAX_SEGMENTS_JSON_BYTES = MIB

// Adjacent chunks time the same words slightly differently, so the next chunk
// may start a segment just before the last kept one ends.
const RESUME_TOLERANCE_SECONDS = 0.25

// Without a prompt, Whisper picks a style per chunk from how the chunk happens
// to start: one came back with no capitals or punctuation, another as fragments
// of a few words per segment. Words in the prompt get echoed or pull other
// languages towards English, which punctuation alone does not.
const WHISPER_INITIAL_PROMPT = '.,?!'

// On audio with no speech, Whisper answers with part of the prompt, like ' .,'.
function isPromptEcho(text: string | undefined) {
    return text !== undefined && /^[\p{P}\s]*$/u.test(text)
}

const MAX_ERROR_MESSAGE_LENGTH = 500

// An unfinished request younger than this may still be starting its Workflow.
const ORPHAN_MIN_AGE_MS = 60 * 1000

// Longer than any step can take with its retries. Only a Workflow engine that
// has lost the instance goes this long without progress: `wrangler dev` does
// not resume instances after a restart, yet still reports them as running.
const STALLED_AFTER_MS = 60 * 60 * 1000

export interface TranscribeParams {
    readonly transcriptId: number
    /** The request that asked for the transcript, so the Workflow logs under its ids. */
    readonly trace?: TaskTrace
}

export function transcriptInstanceId(transcriptId: number) {
    return `transcript-${transcriptId}`
}

export interface TranscriptionLimits {
    /** Size of the R2 multipart parts the download is buffered into (R2's minimum is 5 MiB). */
    readonly partBytes: number
    /** Audio sent to Whisper per request; longer files are split into byte ranges of about this size. */
    readonly chunkBytes: number
    /** Audio shared by adjacent chunks. Whisper garbles the audio around a cut, so the transcript switches chunks mid-overlap. */
    readonly overlapBytes: number
    /** Longest audio sent per request, where the duration is known ahead of transcribing. */
    readonly chunkSeconds: number
    readonly overlapSeconds: number
    /** Chunks transcribed at once; the partial transcript is published after each group. */
    readonly concurrency: number
    /** Largest file in a format that cannot be split, which goes to Whisper whole through its batch API. */
    readonly batchMaxBytes: number
    /** Episodes larger than this are rejected instead of downloaded. */
    readonly maxBytes: number
}

export const DEFAULT_LIMITS: TranscriptionLimits = {
    partBytes: 10 * MIB,
    chunkBytes: 5 * MIB,
    overlapBytes: MIB / 4,
    chunkSeconds: CHUNK_SECONDS,
    overlapSeconds: OVERLAP_SECONDS,
    concurrency: 4,
    batchMaxBytes: 25 * MIB,
    maxBytes: 400 * MIB,
}

interface WhisperSegment {
    text?: string
    start?: number
    end?: number
    words?: Array<{word?: string, start?: number, end?: number}>
}

interface WhisperBatchResult {
    text: string
    transcription_info?: {language?: string, duration?: number}
    segments?: WhisperSegment[]
}

type WhisperBatchSubmitResponse = {request_id?: string, status?: string}
// A finished request answers with the Whisper result itself at the top level;
// `result` and `responses` cover the other shapes the batch API documents.
type WhisperBatchPollResponse = Partial<WhisperBatchResult> & {
    status?: string
    responses?: Array<{success: boolean, result?: WhisperBatchResult, error?: unknown}>
    result?: WhisperBatchResult
    success?: boolean
    error?: unknown
}

interface StoredAudio {
    readonly key: string
    readonly size: number
    /** Whether the file is a stream of self-contained frames (MP3, ADTS AAC) that can be cut anywhere. */
    readonly splittable: boolean
    /** An ADTS stream, whose cuts have to be moved to the next frame to decode. */
    readonly adts?: boolean
    /** An MP4 container, which may hold AAC that can be turned into an ADTS stream. */
    readonly mp4?: boolean
    readonly seconds?: number
}

interface ByteRange {
    readonly offset: number
    readonly length: number
}

function audioKey(transcriptId: number) {
    return `transcribe/${transcriptId}/audio`
}

function adtsKey(transcriptId: number) {
    return `transcribe/${transcriptId}/audio.aac`
}

function chunkResultKey(transcriptId: number, index: number) {
    return `transcribe/${transcriptId}/chunk-${index}.json`
}

function megabytes(bytes: number) {
    return Math.round(bytes / MIB)
}

/** The Workflows engine rethrows a failed step's error with its class name prefixed to the message. */
function errorMessage(err: unknown) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/^(\w*Error: )+/, '')
    // Some failures (a redirect loop lists every URL it visited) run to tens of kilobytes.
    return message.length > MAX_ERROR_MESSAGE_LENGTH ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : message
}

/** Layer 00 of an MPEG audio sync word is ADTS (1111 in the high nibble). */
function isAdtsHeader(bytes: Uint8Array, offset: number) {
    return offset + 1 < bytes.byteLength && bytes[offset] === 0xFF && (bytes[offset + 1] & 0xF6) === 0xF0
}

/** An MPEG audio (layer I-III) or ADTS AAC frame header starts at `offset`. */
function isFrameHeader(bytes: Uint8Array, offset: number) {
    if (offset + 1 >= bytes.byteLength) return false
    const [first, second] = [bytes[offset], bytes[offset + 1]]
    if (first !== 0xFF || (second & 0xE0) !== 0xE0) return false
    const version = (second >> 3) & 0b11
    const layer = (second >> 1) & 0b11
    // MPEG version 01 is reserved.
    return layer === 0 ? isAdtsHeader(bytes, offset) : version !== 0b01
}

/** The offset after any ID3v2 tag. An ID3 tag alone says nothing: FLAC and WAV files carry them too. */
function afterId3Tag(head: Uint8Array) {
    if (head.byteLength < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0
    // The tag size is a 28-bit "synchsafe" integer, excluding the header and any footer.
    const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
    const footer = head[5] & 0x10 ? 10 : 0
    return 10 + size + footer
}

/**
 * Whether the file starts with an audio frame, after any ID3v2 tag. A tag that
 * runs past `head` (the first R2 part) is treated as unsplittable.
 */
export function isFrameStream(head: Uint8Array) {
    return isFrameHeader(head, afterId3Tag(head))
}

/** Whether the file starts with the `ftyp` box of an MP4 container. */
export function isMp4(head: Uint8Array) {
    return head.byteLength >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
}

/** Buffers writes into the equal-sized parts R2 requires, so at most one part is held in memory. */
async function createPartWriter(env: Env, key: string, partBytes: number, onPart?: (part: Uint8Array) => void) {
    const upload = await env.RSS_CACHE_BUCKET.createMultipartUpload(key)
    const parts: R2UploadedPart[] = []
    const buffer = new Uint8Array(partBytes)
    let filled = 0

    const flush = async () => {
        const part = buffer.subarray(0, filled)
        onPart?.(part)
        // Awaited before the buffer is refilled, so the view needs no copy.
        parts.push(await upload.uploadPart(parts.length + 1, part))
        filled = 0
    }

    return {
        async write(bytes: Uint8Array) {
            let offset = 0
            while (offset < bytes.byteLength) {
                const count = Math.min(bytes.byteLength - offset, buffer.byteLength - filled)
                buffer.set(bytes.subarray(offset, offset + count), filled)
                filled += count
                offset += count
                if (filled === buffer.byteLength) await flush()
            }
        },
        async complete() {
            if (filled > 0) await flush()
            await upload.complete(parts)
        },
        abort: () => upload.abort().catch(() => {}),
    }
}

/**
 * Streams the enclosure into R2 as a multipart upload, so at most one part
 * (not the episode) is held in memory.
 */
export async function downloadAudio(env: Env, url: string, key: string, limits: TranscriptionLimits): Promise<StoredAudio> {
    const tooLarge = () => new NonRetryableError(`Audio is larger than the ${megabytes(limits.maxBytes)} MB transcription limit`)

    const upstream = await fetch(url, {headers: {'User-Agent': FETCH_USER_AGENT}})
    if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel()
        const message = `Upstream fetch failed: HTTP ${upstream.status}`
        // A client error other than a timeout or rate limit will not go away on a retry.
        const permanent = upstream.status >= 400 && upstream.status < 500 && upstream.status !== 408 && upstream.status !== 429
        throw permanent ? new NonRetryableError(message) : new Error(message)
    }
    if (Number(upstream.headers.get('Content-Length')) > limits.maxBytes) {
        await upstream.body.cancel()
        throw tooLarge()
    }

    let kind: Pick<StoredAudio, 'splittable' | 'adts' | 'mp4'> | undefined
    const writer = await createPartWriter(env, key, limits.partBytes, head => {
        kind ??= {splittable: isFrameStream(head), adts: isAdtsHeader(head, afterId3Tag(head)), mp4: isMp4(head)}
    })
    try {
        let size = 0
        const reader = upstream.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
        for (;;) {
            const {done, value} = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > limits.maxBytes) {
                await reader.cancel()
                throw tooLarge()
            }
            await writer.write(value)
        }
        if (size === 0) throw new NonRetryableError('Audio download was empty')
        await writer.complete()
        return {key, size, ...kind ?? {splittable: false}}
    } catch (err) {
        await writer.abort()
        throw err
    }
}

/**
 * Rewrites the AAC track of an MP4 as an ADTS stream, by giving each frame a
 * header in place of the container's tables, without decoding anything. Returns
 * null for a file without such a track (other codecs, fragmented MP4).
 */
export async function extractAdts(env: Env, source: StoredAudio, key: string, limits: TranscriptionLimits): Promise<StoredAudio | null> {
    const read = async (offset: number, length: number) => {
        const object = await env.RSS_CACHE_BUCKET.get(source.key, {range: {offset, length}})
        if (!object) throw new Error('Downloaded audio is missing from storage')
        return new Uint8Array(await object.arrayBuffer())
    }

    const moov = await findMoov(read, source.size)
    if (!moov || moov.length > MAX_MOOV_BYTES) return null
    const track = parseAacTrack(await read(moov.offset, moov.length))
    if (!track) return null

    const writer = await createPartWriter(env, key, limits.partBytes)
    try {
        let size = 0
        let window = new Uint8Array()
        let windowOffset = 0
        for (const sample of track.samples()) {
            if (sample.offset + sample.size > source.size) {
                await writer.abort()
                return null
            }
            if (sample.offset < windowOffset || sample.offset + sample.size > windowOffset + window.byteLength) {
                windowOffset = sample.offset
                window = await read(windowOffset, Math.min(Math.max(limits.partBytes, sample.size), source.size - windowOffset))
            }
            const start = sample.offset - windowOffset
            await writer.write(adtsHeader(track, sample.size))
            await writer.write(window.subarray(start, start + sample.size))
            size += ADTS_HEADER_BYTES + sample.size
        }
        await writer.complete()
        return {key, size, splittable: true, adts: true, ...track.seconds > 0 ? {seconds: track.seconds} : {}}
    } catch (err) {
        await writer.abort()
        throw err
    }
}

/**
 * Byte ranges to transcribe separately, each running `overlapBytes` into the
 * next. A file up to a quarter over the chunk size still goes in one request
 * rather than leaving a sliver of a chunk.
 */
export function planChunks(audio: Pick<StoredAudio, 'size' | 'splittable' | 'seconds'>, limits: TranscriptionLimits): ByteRange[] {
    if (!audio.splittable) {
        if (audio.size <= limits.batchMaxBytes) return [{offset: 0, length: audio.size}]
        throw new NonRetryableError(
            `Audio is ${megabytes(audio.size)} MB; only MP3 and AAC audio can be split, and other formats are limited to ${megabytes(limits.batchMaxBytes)} MB`,
        )
    }

    const bytesPerSecond = audio.seconds ? audio.size / audio.seconds : Infinity
    const chunkBytes = Math.min(limits.chunkBytes, Math.ceil(limits.chunkSeconds * bytesPerSecond))
    const overlapBytes = Math.min(limits.overlapBytes, Math.ceil(limits.overlapSeconds * bytesPerSecond))
    if (audio.size <= chunkBytes * 1.25) return [{offset: 0, length: audio.size}]

    const count = Math.ceil(audio.size / chunkBytes)
    const stride = Math.ceil(audio.size / count)
    return Array.from({length: count}, (_, i) => ({
        offset: i * stride,
        length: Math.min(stride + overlapBytes, audio.size - i * stride),
    }))
}

async function readChunkAudio(env: Env, audio: StoredAudio, range: ByteRange) {
    const object = await env.RSS_CACHE_BUCKET.get(audio.key, {range})
    if (!object) throw new Error('Downloaded audio is missing from storage')
    const bytes = new Uint8Array(await object.arrayBuffer())
    return Buffer.from(audio.adts ? bytes.subarray(firstAdtsFrame(bytes)) : bytes).toString('base64')
}

function whisperInput(audio: string, language: string | null) {
    return {audio, task: 'transcribe', ...(language ? {language} : {}), vad_filter: true, initial_prompt: WHISPER_INITIAL_PROMPT}
}

/** Parks a chunk's result in R2, as a step may only return 1 MiB; `vtt` repeats the segments. */
async function storeChunkResult(env: Env, transcriptId: number, index: number, {text, transcription_info, segments}: WhisperBatchResult) {
    await env.RSS_CACHE_BUCKET.put(chunkResultKey(transcriptId, index), JSON.stringify({text, transcription_info, segments}))
}

/**
 * Transcribes one byte range synchronously. Chunks of this size finish in
 * about 30 seconds, where the same audio spends minutes in the batch API.
 */
async function transcribeChunk(env: Env, transcriptId: number, audio: StoredAudio, job: {model: string, language: string | null}, index: number, range: ByteRange) {
    const startedAt = Date.now()
    const result = await env.AI.run(
        job.model as '@cf/openai/whisper-large-v3-turbo',
        whisperInput(await readChunkAudio(env, audio, range), job.language),
    ) as unknown as WhisperBatchResult
    if (typeof result.text !== 'string') throw new Error('Whisper returned no text')
    await storeChunkResult(env, transcriptId, index, result)
    log.info('Transcribed a chunk', {chunk: index + 1, audioSeconds: result.transcription_info?.duration, durationMs: Date.now() - startedAt})
}

/** Runs one group of chunk steps to the end, so a failure never leaves others running during clean up. */
async function transcribeGroup(group: ReadonlyArray<() => Promise<unknown>>) {
    const settled = await Promise.allSettled(group.map(run => run()))
    const failed = settled.find(outcome => outcome.status === 'rejected')
    if (failed) throw failed.reason
}

async function submitBatch(env: Env, audio: StoredAudio, job: {model: string, language: string | null}, range: ByteRange) {
    // queueRequest switches env.AI.run into batch mode, for audio too long for
    // the synchronous timeout (504) that cannot be cut into shorter chunks.
    const submitted = await env.AI.run(
        job.model as '@cf/openai/whisper-large-v3-turbo',
        whisperInput(await readChunkAudio(env, audio, range), job.language),
        {queueRequest: true} as never,
    ) as unknown as WhisperBatchSubmitResponse
    if (!submitted.request_id) throw new Error('Batch submission returned no request_id')
    return submitted.request_id
}

/** Polls a batch request once, parking its result in R2 once finished; returns whether it has. */
async function pollBatch(env: Env, transcriptId: number, model: string, requestId: string) {
    let poll: WhisperBatchPollResponse
    try {
        poll = await env.AI.run(model as '@cf/openai/whisper-large-v3-turbo', {
            request_id: requestId,
        } as never) as unknown as WhisperBatchPollResponse
    } catch (err) {
        // Treat transient poll failures as "not ready"; MAX_POLLS bounds them.
        log.warn('Polling a Whisper batch request failed; will retry', {batchRequestId: requestId, error: err})
        return false
    }

    const arrayResponse = poll.responses?.[0]
    const result = arrayResponse?.result ?? poll.result ?? (typeof poll.text === 'string' ? poll as WhisperBatchResult : undefined)
    const success = arrayResponse?.success ?? poll.success
    const error = arrayResponse?.error ?? poll.error

    if (result && (success ?? true)) {
        await storeChunkResult(env, transcriptId, 0, result)
        return true
    } else if (success === false || error) {
        throw new NonRetryableError(error ? JSON.stringify(error) : 'Inference failed')
    }
    return false  // still queued/running
}

/** The language most chunks were detected as: an English intro must not label a Mandarin episode. */
function majorityLanguage(results: readonly WhisperBatchResult[]) {
    const counts = new Map<string, number>()
    for (const {transcription_info} of results) {
        if (transcription_info?.language) counts.set(transcription_info.language, (counts.get(transcription_info.language) ?? 0) + 1)
    }
    let majority: string | null = null
    for (const [language, count] of counts) {
        if (majority === null || count > counts.get(majority)!) majority = language
    }
    return majority
}

/**
 * Joins per-chunk results into one transcript, shifting each chunk's segment
 * (and word) timestamps by the duration of the audio before it. `results` may
 * be a prefix of `ranges`, for a partial transcript.
 *
 * Adjacent chunks overlap, and each has garbled audio at its cut: the
 * transcript follows a chunk up to the middle of its overlap with the next,
 * then picks up the next chunk after the last segment kept, from the first
 * word past it if one of the next chunk's segments straddles that point.
 *
 * A chunk without a reported duration is estimated from its byte length at
 * the rate of the chunks that have one; its last segment's end would come up
 * short, as the VAD filter trims trailing silence.
 *
 * A chunk with no speech adds no text or segments, but still takes up its time.
 */
export function stitchResults(results: readonly WhisperBatchResult[], ranges: readonly ByteRange[] = []) {
    let timedBytes = 0
    let timedSeconds = 0
    results.forEach((result, index) => {
        const duration = result.transcription_info?.duration
        if (duration !== undefined && ranges[index]) {
            timedBytes += ranges[index].length
            timedSeconds += duration
        }
    })
    const durationOf = (result: WhisperBatchResult, index: number) => {
        const reported = result.transcription_info?.duration
        if (reported !== undefined) return reported
        if (timedBytes > 0 && ranges[index]) return ranges[index].length * timedSeconds / timedBytes
        const segments = result.segments ?? []
        return segments[segments.length - 1]?.end ?? 0
    }

    const segments: WhisperSegment[] = []
    const texts: string[] = []
    let offset = 0
    let resumeAt = -Infinity
    for (const [index, result] of results.entries()) {
        const shift = (time: number | undefined) => time === undefined ? time : time + offset
        const range = ranges[index]
        const next = ranges[index + 1]
        const duration = durationOf(result, index)
        const secondsPerByte = range?.length ? duration / range.length : 0
        const overlapSeconds = range && next ? (range.offset + range.length - next.offset) * secondsPerByte : 0
        const nextOffset = next ? offset + (next.offset - range.offset) * secondsPerByte : offset + duration
        const cut = overlapSeconds > 0 ? nextOffset + overlapSeconds / 2 : Infinity

        const chunkSegments = result.segments ?? []
        const kept = chunkSegments.flatMap((segment): WhisperSegment[] => {
            const start = shift(segment.start) ?? offset
            if (start >= cut) return []
            if (start >= resumeAt) return [segment]
            const tail = segment.words?.filter(word => (shift(word.start) ?? -Infinity) >= resumeAt) ?? []
            return tail.length > 0 ? [{...segment, start: tail[0].start, words: tail, text: tail.map(word => word.word ?? '').join('')}] : []
        }).filter(segment => !isPromptEcho(segment.text))
        for (const segment of kept) {
            // The prompt makes Whisper jitter timestamps on a chunk it misdetects
            // as English (a Mandarin episode's English intro); its text is in order.
            const start = shift(segment.start)
            const earliest = segments[segments.length - 1]?.start
            segments.push({
                ...segment,
                start: start !== undefined && earliest !== undefined ? Math.max(start, earliest) : start,
                end: shift(segment.end),
                ...(segment.words ? {words: segment.words.map(w => ({...w, start: shift(w.start), end: shift(w.end)}))} : {}),
            })
        }
        const trimmed = overlapSeconds > 0 || resumeAt !== -Infinity
        const followSegments = chunkSegments.length > 0 && (trimmed || kept.length < chunkSegments.length)
        if (followSegments) texts.push(kept.map(segment => segment.text?.trim() ?? '').join(' '))
        else if (!isPromptEcho(result.text)) texts.push(result.text.trim())

        resumeAt = overlapSeconds > 0
            ? (segments[segments.length - 1]?.end ?? -Infinity) - RESUME_TOLERANCE_SECONDS
            : -Infinity
        offset = nextOffset
    }

    return {
        text: texts.filter(Boolean).join(' '),
        segments: segments.length > 0 ? segments : null,
        language: majorityLanguage(results),
    }
}

/**
 * Serialises the segments within the size D1 can store, dropping what the UI
 * can do without first: word timestamps (it seeks by segment), then Whisper's
 * per-segment scores, which outweigh the text of the short segments of Mandarin
 * speech, and only then the segments altogether.
 */
export function serializeSegments(segments: readonly WhisperSegment[] | null, maxBytes = MAX_SEGMENTS_JSON_BYTES) {
    if (!segments) return null
    const fits = (json: string) => Buffer.byteLength(json) <= maxBytes
    const full = JSON.stringify(segments)
    if (fits(full)) return full
    const withoutWords = JSON.stringify(segments.map(segment => ({...segment, words: undefined})))
    if (fits(withoutWords)) return withoutWords
    const essentials = JSON.stringify(segments.map(({start, end, text}) => ({start, end, text})))
    return fits(essentials) ? essentials : null
}

async function stitchStoredChunks(env: Env, transcriptId: number, chunks: readonly ByteRange[], count: number) {
    const results: WhisperBatchResult[] = []
    for (let index = 0; index < count; index++) {
        const object = await env.RSS_CACHE_BUCKET.get(chunkResultKey(transcriptId, index))
        if (!object) throw new Error(`Result of chunk ${index + 1} is missing from storage`)
        results.push(await object.json<WhisperBatchResult>())
    }
    return stitchResults(results, chunks)
}

/** Stores the transcript of the first `count` chunks on the unfinished row, for the UI to show. */
async function publishPartial(env: Env, transcriptId: number, requestedLanguage: string | null, chunks: readonly ByteRange[], count: number) {
    const {text, segments, language} = await stitchStoredChunks(env, transcriptId, chunks, count)
    await updateTranscriptStatus(env.DB, transcriptId, {
        text,
        segments_json: serializeSegments(segments),
        language: language ?? requestedLanguage,
        chunks_done: count,
        last_progress_at: new Date().toISOString(),
    })
}

async function persistTranscript(env: Env, transcriptId: number, requestedLanguage: string | null, chunks: readonly ByteRange[]) {
    const {text, segments, language} = await stitchStoredChunks(env, transcriptId, chunks, chunks.length)
    await updateTranscriptStatus(env.DB, transcriptId, {
        status: 'complete',
        text,
        segments_json: serializeSegments(segments),
        language: language ?? requestedLanguage,
        chunks_done: chunks.length,
        completed_at: new Date().toISOString(),
    })
}

async function deleteWorkingFiles(env: Env, transcriptId: number) {
    const bucket = env.RSS_CACHE_BUCKET
    const {objects} = await bucket.list({prefix: `transcribe/${transcriptId}/`})
    if (objects.length > 0) await bucket.delete(objects.map(object => object.key))
}

/**
 * The transcription pipeline, as durable Workflow steps:
 *   start -> stream the enclosure to R2 -> rewrite the AAC of an MP4 as ADTS ->
 *   transcribe groups of overlapping chunks, publishing the partial transcript
 *   after each -> stitch and persist.
 * Audio that cannot be split goes through a Whisper batch request instead,
 * polled with sleeps until it is done.
 * The `transcript` row is the API-facing record: `processing` once the
 * Workflow starts, then `complete` or `error`.
 */
export async function runTranscription(transcriptId: number, env: Env, step: WorkflowStep, limits: TranscriptionLimits = DEFAULT_LIMITS) {
    try {
        const job = await step.do('start', async () => {
            const transcript = await ServerTranscript.get(env.DB, transcriptId)
            if (!transcript || transcript.status === 'complete' || transcript.status === 'error') return null

            const feedItem = await ServerFeedItem.get(env.DB, transcript.feed_item_guid)
            if (!feedItem?.enclosure_url) throw new NonRetryableError('Feed item has no enclosure_url')

            await updateTranscriptStatus(env.DB, transcriptId, {status: 'processing', started_at: new Date().toISOString()})
            return {
                url: feedItem.enclosure_url,
                feedItemGuid: feedItem.guid,
                model: transcript.model,
                language: transcript.language,
            }
        })
        if (!job) {
            log.info('Transcript is already finished or no longer exists')
            return
        }

        const downloaded = await step.do(
            'download audio',
            {retries: {limit: 2, delay: '10 seconds', backoff: 'exponential'}, timeout: '15 minutes'},
            () => downloadAudio(env, job.url, audioKey(transcriptId), limits),
        )
        const extracted = downloaded.mp4 ? await step.do(
            'extract AAC frames',
            {retries: {limit: 2, delay: '10 seconds', backoff: 'exponential'}, timeout: '15 minutes'},
            () => extractAdts(env, downloaded, adtsKey(transcriptId), limits),
        ) : null
        const audio = extracted ?? downloaded

        const chunks = planChunks(audio, limits)
        log.info('Downloaded audio for transcription', {audioBytes: downloaded.size, extractedBytes: extracted?.size, audioSeconds: audio.seconds, splittable: audio.splittable, chunks: chunks.length})
        await step.do('record plan', () => updateTranscriptStatus(env.DB, transcriptId, {
            chunks_total: chunks.length,
            last_progress_at: new Date().toISOString(),
        }))

        if (audio.splittable) {
            for (let done = 0; done < chunks.length; done += limits.concurrency) {
                await transcribeGroup(chunks.slice(done, done + limits.concurrency).map((range, i) => () => step.do(
                    `transcribe chunk ${done + i + 1}`,
                    CHUNK_STEP_CONFIG,
                    () => transcribeChunk(env, transcriptId, audio, job, done + i, range),
                )))
                const finished = done + limits.concurrency
                if (finished < chunks.length) {
                    await step.do(`publish ${finished} chunks`, () => publishPartial(env, transcriptId, job.language, chunks, finished))
                }
            }
        } else {
            const requestId = await step.do(
                'submit batch',
                {retries: {limit: 2, delay: '10 seconds', backoff: 'exponential'}, timeout: '5 minutes'},
                () => submitBatch(env, audio, job, chunks[0]),
            )
            for (let round = 1, finished = false; !finished; round++) {
                if (round > MAX_POLLS) throw new Error('Timed out waiting for Whisper batch result')
                await step.sleep(`wait ${round}`, POLL_INTERVAL)
                finished = await step.do(`poll ${round}`, async () => {
                    await updateTranscriptStatus(env.DB, transcriptId, {last_progress_at: new Date().toISOString()})
                    return pollBatch(env, transcriptId, job.model, requestId)
                })
            }
        }

        await step.do('persist transcript', () => persistTranscript(env, transcriptId, job.language, chunks))
        log.info('Transcription complete', {chunks: chunks.length})
        await step.do('index transcript', async () => {
            // The transcript is stored; a search index failure must not fail it.
            try {
                const feedItem = await ServerFeedItem.get(env.DB, job.feedItemGuid)
                await feedItem?.refreshTextSearch(env.DB)
            } catch (err) {
                log.error('Refreshing the search index after transcription failed', {error: err})
            }
        })
    } catch (err) {
        const message = errorMessage(err)
        log.error('Transcription failed', {reason: message, error: err})
        await step.do('record failure', () => updateTranscriptStatus(env.DB, transcriptId, {
            status: 'error',
            error_message: message,
            completed_at: new Date().toISOString(),
        }))
    } finally {
        await step.do('clean up', () => deleteWorkingFiles(env, transcriptId))
    }
}

/**
 * Fails an unfinished request whose Workflow instance has ended, never
 * existed (it was terminated, crashed outside its own error handling, or was
 * left by the old queue pipeline), or claims to be running but has stopped
 * advancing, so it stops counting as in progress. Returns the request as it
 * now stands.
 */
export async function failIfOrphaned(env: Env, workflow: Workflow<TranscribeParams>, transcript: ServerTranscript) {
    const unfinished = transcript.status === 'pending' || transcript.status === 'processing'
    if (!unfinished || Date.now() - transcript.requested_at.getTime() < ORPHAN_MIN_AGE_MS) return transcript

    let instanceStatus: string
    let instance: WorkflowInstance | null = null
    try {
        instance = await workflow.get(transcriptInstanceId(transcript.id))
        instanceStatus = (await instance.status()).status
    } catch (err) {
        if (!(err instanceof Error && err.message.includes('instance.not_found'))) {
            // Unknown, so assume it is still running rather than fail it.
            log.warn('Could not look up a transcription Workflow', {transcriptId: transcript.id, error: err})
            return transcript
        }
        instanceStatus = 'not_found'
    }

    const ended = ['complete', 'errored', 'terminated', 'not_found'].includes(instanceStatus)
    const lastProgress = transcript.last_progress_at ?? transcript.started_at ?? transcript.requested_at
    const stalled = !ended && Date.now() - lastProgress.getTime() > STALLED_AFTER_MS
    if (!ended && !stalled) return transcript

    log.warn('Failing a transcript whose Workflow is gone', {transcriptId: transcript.id, instanceStatus, stalled})
    // A stalled instance must not wake up later and overwrite the outcome.
    if (stalled) await instance?.terminate().catch((err: unknown) => log.warn('Could not terminate a stalled Workflow', {transcriptId: transcript.id, error: err}))
    await updateTranscriptStatus(env.DB, transcript.id, {
        status: 'error',
        error_message: 'Transcription stopped unexpectedly; request it again',
        completed_at: new Date().toISOString(),
    })
    return (await ServerTranscript.get(env.DB, transcript.id))!
}

export class TranscribeWorkflow extends WorkflowEntrypoint<Env, TranscribeParams> {
    async run(event: Readonly<WorkflowEvent<TranscribeParams>>, step: WorkflowStep) {
        const {transcriptId, trace} = event.payload
        await withLogContext({...trace, transcriptId}, () => runTranscription(transcriptId, this.env, step))
    }
}
