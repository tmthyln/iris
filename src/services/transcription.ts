import {Buffer} from "node:buffer";
import {WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep} from "cloudflare:workers";
import {NonRetryableError} from "cloudflare:workflows";
import {updateTranscriptStatus} from "./crud";
import {ServerFeedItem, ServerTranscript} from "./models";
import {FETCH_USER_AGENT} from "./utils/files";
import {log, type TaskTrace, withLogContext} from "./utils/log";

export const TRANSCRIPT_DEFAULT_MODEL = '@cf/openai/whisper-large-v3-turbo'

const MIB = 1024 * 1024

const POLL_INTERVAL = '30 seconds'
// Whisper batch results are polled every POLL_INTERVAL; an hour in total.
const MAX_POLLS = 120

// D1 caps a row at 2 MB; the stitched segments of a very long episode can exceed it.
const MAX_SEGMENTS_JSON_BYTES = MIB

const MAX_ERROR_MESSAGE_LENGTH = 500

// An unfinished request younger than this may still be starting its Workflow.
const ORPHAN_MIN_AGE_MS = 60 * 1000

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
    /** Episodes larger than this are rejected instead of downloaded. */
    readonly maxBytes: number
}

export const DEFAULT_LIMITS: TranscriptionLimits = {
    partBytes: 10 * MIB,
    chunkBytes: 20 * MIB,
    maxBytes: 400 * MIB,
}

interface WhisperSegment {
    start?: number
    end?: number
    words?: Array<{start?: number, end?: number}>
}

interface WhisperBatchResult {
    text: string
    transcription_info?: {language?: string, duration?: number}
    segments?: WhisperSegment[]
}

type WhisperBatchSubmitResponse = {request_id?: string, status?: string}
type WhisperBatchPollResponse = {
    status?: string
    // Some models return a `responses` array; others (single-input models like
    // Whisper when submitted without a `requests` wrapper) may inline the
    // result directly. Handle both.
    responses?: Array<{success: boolean, result?: WhisperBatchResult, error?: unknown}>
    result?: WhisperBatchResult
    success?: boolean
    error?: unknown
}

interface StoredAudio {
    readonly size: number
    /** Whether the file is a stream of self-contained frames (MP3, ADTS AAC) that survives a cut at any byte. */
    readonly splittable: boolean
}

interface ByteRange {
    readonly offset: number
    readonly length: number
}

interface PendingChunk {
    readonly index: number
    readonly requestId: string
}

function audioKey(transcriptId: number) {
    return `transcribe/${transcriptId}/audio`
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

/** An MPEG audio (layer I-III) or ADTS AAC frame header starts at `offset`. */
function isFrameHeader(bytes: Uint8Array, offset: number) {
    if (offset + 1 >= bytes.byteLength) return false
    const [first, second] = [bytes[offset], bytes[offset + 1]]
    if (first !== 0xFF || (second & 0xE0) !== 0xE0) return false
    const version = (second >> 3) & 0b11
    const layer = (second >> 1) & 0b11
    // Layer 00 is ADTS (1111 in the high nibble); MPEG version 01 is reserved.
    return layer === 0 ? (second & 0xF6) === 0xF0 : version !== 0b01
}

/**
 * Whether the file starts with an audio frame, after any ID3v2 tag. An ID3
 * tag alone says nothing: FLAC and WAV files carry them too. A tag that runs
 * past `head` (the first R2 part) is treated as unsplittable.
 */
export function isFrameStream(head: Uint8Array) {
    let offset = 0
    if (head.byteLength >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
        // The tag size is a 28-bit "synchsafe" integer, excluding the header and any footer.
        const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
        const footer = head[5] & 0x10 ? 10 : 0
        offset = 10 + size + footer
    }
    return isFrameHeader(head, offset)
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

    const upload = await env.RSS_CACHE_BUCKET.createMultipartUpload(key)
    try {
        const parts: R2UploadedPart[] = []
        const buffer = new Uint8Array(limits.partBytes)
        let filled = 0
        let size = 0
        let splittable: boolean | undefined

        const flush = async () => {
            const part = buffer.subarray(0, filled)
            splittable ??= isFrameStream(part)
            // Awaited before the buffer is refilled, so the view needs no copy.
            parts.push(await upload.uploadPart(parts.length + 1, part))
            filled = 0
        }

        const reader = upstream.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
        for (;;) {
            const {done, value} = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > limits.maxBytes) {
                await reader.cancel()
                throw tooLarge()
            }
            let offset = 0
            while (offset < value.byteLength) {
                const count = Math.min(value.byteLength - offset, buffer.byteLength - filled)
                buffer.set(value.subarray(offset, offset + count), filled)
                filled += count
                offset += count
                if (filled === buffer.byteLength) await flush()
            }
        }
        if (size === 0) throw new NonRetryableError('Audio download was empty')
        if (filled > 0) await flush()

        await upload.complete(parts)
        return {size, splittable: splittable ?? false}
    } catch (err) {
        await upload.abort().catch(() => {})
        throw err
    }
}

/**
 * Byte ranges to transcribe separately. A file up to a quarter over the chunk
 * size still goes in one request rather than leaving a sliver of a chunk.
 */
export function planChunks(audio: StoredAudio, limits: TranscriptionLimits): ByteRange[] {
    const singleMax = limits.chunkBytes * 1.25
    if (audio.size <= singleMax) return [{offset: 0, length: audio.size}]
    if (!audio.splittable) {
        throw new NonRetryableError(
            `Audio is ${megabytes(audio.size)} MB; only MP3 audio can be split, and other formats are limited to ${megabytes(singleMax)} MB`,
        )
    }

    const count = Math.ceil(audio.size / limits.chunkBytes)
    const length = Math.ceil(audio.size / count)
    return Array.from({length: count}, (_, i) => ({
        offset: i * length,
        length: Math.min(length, audio.size - i * length),
    }))
}

async function submitChunk(env: Env, transcriptId: number, model: string, language: string | null, range: ByteRange) {
    const object = await env.RSS_CACHE_BUCKET.get(audioKey(transcriptId), {range})
    if (!object) throw new Error('Downloaded audio is missing from storage')
    const audioBase64 = Buffer.from(await object.arrayBuffer()).toString('base64')

    // Whisper's batch input mirrors its sync input — audio/task/language at the
    // root — with queueRequest:true switching env.AI.run into batch mode.
    // Podcast-length audio exceeds the synchronous AI.run timeout (504), which
    // is why this goes through batch.
    const submitted = await env.AI.run(model as '@cf/openai/whisper-large-v3-turbo', {
        audio: audioBase64,
        task: 'transcribe',
        ...(language ? {language} : {}),
        vad_filter: true,
    }, {queueRequest: true} as never) as unknown as WhisperBatchSubmitResponse
    if (!submitted.request_id) throw new Error('Batch submission returned no request_id')
    return submitted.request_id
}

/**
 * Polls every outstanding chunk once. Finished results are parked in R2 (a
 * step may only return 1 MiB) and their chunk indexes returned.
 */
async function pollChunks(env: Env, transcriptId: number, model: string, pending: readonly PendingChunk[]) {
    const polled = await Promise.all(pending.map(async chunk => {
        let poll: WhisperBatchPollResponse
        try {
            poll = await env.AI.run(model as '@cf/openai/whisper-large-v3-turbo', {
                request_id: chunk.requestId,
            } as never) as unknown as WhisperBatchPollResponse
        } catch (err) {
            // Treat transient poll failures as "not ready"; MAX_POLLS bounds them.
            log.warn('Polling a Whisper batch request failed; will retry', {chunk: chunk.index + 1, batchRequestId: chunk.requestId, error: err})
            return null
        }

        const arrayResponse = poll.responses?.[0]
        const result = arrayResponse?.result ?? poll.result
        const success = arrayResponse?.success ?? poll.success
        const error = arrayResponse?.error ?? poll.error

        if (result && (success ?? true)) {
            await env.RSS_CACHE_BUCKET.put(chunkResultKey(transcriptId, chunk.index), JSON.stringify(result))
            return chunk.index
        } else if (success === false || error) {
            throw new NonRetryableError(error ? JSON.stringify(error) : 'Inference failed')
        }
        return null  // still queued/running
    }))
    return polled.filter(index => index !== null)
}

/**
 * Joins per-chunk results into one transcript, shifting each chunk's segment
 * (and word) timestamps by the duration of the audio before it.
 *
 * A chunk without a reported duration is estimated from its byte length at
 * the rate of the chunks that have one; its last segment's end would come up
 * short, as the VAD filter trims trailing silence.
 */
export function stitchResults(results: readonly WhisperBatchResult[], chunkBytes: readonly number[] = []) {
    let timedBytes = 0
    let timedSeconds = 0
    results.forEach((result, index) => {
        const duration = result.transcription_info?.duration
        if (duration !== undefined && chunkBytes[index]) {
            timedBytes += chunkBytes[index]
            timedSeconds += duration
        }
    })
    const durationOf = (result: WhisperBatchResult, index: number) => {
        const reported = result.transcription_info?.duration
        if (reported !== undefined) return reported
        if (timedBytes > 0 && chunkBytes[index]) return chunkBytes[index] * timedSeconds / timedBytes
        const segments = result.segments ?? []
        return segments[segments.length - 1]?.end ?? 0
    }

    const segments: WhisperSegment[] = []
    let offset = 0
    for (const [index, result] of results.entries()) {
        const shift = (time: number | undefined) => time === undefined ? time : time + offset
        const chunkSegments = result.segments ?? []
        for (const segment of chunkSegments) {
            segments.push({
                ...segment,
                start: shift(segment.start),
                end: shift(segment.end),
                ...(segment.words ? {words: segment.words.map(w => ({...w, start: shift(w.start), end: shift(w.end)}))} : {}),
            })
        }
        offset += durationOf(result, index)
    }

    return {
        text: results.map(r => r.text.trim()).filter(Boolean).join(' '),
        segments: segments.length > 0 ? segments : null,
        language: results[0]?.transcription_info?.language ?? null,
    }
}

/**
 * Serialises the segments within the size D1 can store: word timestamps are
 * dropped first (the UI seeks by segment), then the segments altogether.
 */
export function serializeSegments(segments: readonly WhisperSegment[] | null, maxBytes = MAX_SEGMENTS_JSON_BYTES) {
    if (!segments) return null
    const fits = (json: string) => Buffer.byteLength(json) <= maxBytes
    const full = JSON.stringify(segments)
    if (fits(full)) return full
    const withoutWords = JSON.stringify(segments.map(segment => ({...segment, words: undefined})))
    return fits(withoutWords) ? withoutWords : null
}

async function persistTranscript(env: Env, transcriptId: number, requestedLanguage: string | null, chunks: readonly ByteRange[]) {
    const results: WhisperBatchResult[] = []
    for (let index = 0; index < chunks.length; index++) {
        const object = await env.RSS_CACHE_BUCKET.get(chunkResultKey(transcriptId, index))
        if (!object) throw new Error(`Result of chunk ${index + 1} is missing from storage`)
        results.push(await object.json<WhisperBatchResult>())
    }

    const {text, segments, language} = stitchResults(results, chunks.map(chunk => chunk.length))
    await updateTranscriptStatus(env.DB, transcriptId, {
        status: 'complete',
        text,
        segments_json: serializeSegments(segments),
        language: language ?? requestedLanguage,
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
 *   start -> stream the enclosure to R2 -> submit a Whisper batch request per
 *   chunk -> sleep/poll until every chunk is done -> stitch and persist.
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

        const audio = await step.do(
            'download audio',
            {retries: {limit: 2, delay: '10 seconds', backoff: 'exponential'}, timeout: '15 minutes'},
            () => downloadAudio(env, job.url, audioKey(transcriptId), limits),
        )

        const chunks = planChunks(audio, limits)
        log.info('Downloaded audio for transcription', {audioBytes: audio.size, splittable: audio.splittable, chunks: chunks.length})
        let pending: PendingChunk[] = []
        for (const [index, range] of chunks.entries()) {
            const requestId = await step.do(
                `submit chunk ${index + 1}`,
                {retries: {limit: 2, delay: '10 seconds', backoff: 'exponential'}, timeout: '5 minutes'},
                () => submitChunk(env, transcriptId, job.model, job.language, range),
            )
            pending.push({index, requestId})
        }

        for (let round = 1; pending.length > 0; round++) {
            if (round > MAX_POLLS) throw new Error('Timed out waiting for Whisper batch result')
            await step.sleep(`wait ${round}`, POLL_INTERVAL)
            const outstanding = pending
            const finished = await step.do(`poll ${round}`, () => pollChunks(env, transcriptId, job.model, outstanding))
            pending = pending.filter(chunk => !finished.includes(chunk.index))
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
 * Fails an unfinished request whose Workflow instance has ended or never
 * existed (it was terminated, crashed outside its own error handling, or was
 * left by the old queue pipeline), so it stops counting as in progress.
 * Returns the request as it now stands.
 */
export async function failIfOrphaned(env: Env, workflow: Workflow<TranscribeParams>, transcript: ServerTranscript) {
    const unfinished = transcript.status === 'pending' || transcript.status === 'processing'
    if (!unfinished || Date.now() - transcript.requested_at.getTime() < ORPHAN_MIN_AGE_MS) return transcript

    let instanceStatus: string
    try {
        const instance = await workflow.get(transcriptInstanceId(transcript.id))
        instanceStatus = (await instance.status()).status
    } catch (err) {
        if (!(err instanceof Error && err.message.includes('instance.not_found'))) {
            // Unknown, so assume it is still running rather than fail it.
            log.warn('Could not look up a transcription Workflow', {transcriptId: transcript.id, error: err})
            return transcript
        }
        instanceStatus = 'not_found'
    }
    if (!['complete', 'errored', 'terminated', 'not_found'].includes(instanceStatus)) return transcript

    log.warn('Failing a transcript whose Workflow is gone', {transcriptId: transcript.id, instanceStatus})
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
