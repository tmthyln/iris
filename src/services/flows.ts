import {Buffer} from "node:buffer";
import type {ExecutionContext} from "@cloudflare/workers-types";
import {ServerFeed, ServerFeedFile, ServerFeedItem, ServerFeedSource, ServerTranscript} from "./models";
import {
    createFeedFile,
    createFeedItem,
    createNotification,
    getFeedFilesForFeed,
    getFeedItemDateRange,
    getFeedItemFingerprintsByGuids,
    getFeedMaxItemDate,
    getUpdatableFeedSources,
    updateTranscriptStatus,
    type FeedItemFingerprint,
} from "./crud";
import {computeFeedItemContentHash, fetchRssFile, parseRssText, sha256Encode, FETCH_USER_AGENT} from "./utils/files";
import {fetchArchiveList, waybackSnapshotUrl} from "./utils/wayback";
import {fanOutPushWithContext, loadPushFanOutContext, type PushFanOutContext, type PushNotificationPayload} from "./utils/push";
import type {FetchArchiveSnapshotTask} from "./types";

export type FeedItemClassification = 'new' | 'updated' | 'skip'

/**
 * Classify an incoming feed item relative to what's already in the database.
 *  - 'new': not seen before and dated later than anything we currently store
 *  - 'updated': previously stored, with a content hash that no longer matches
 *  - 'skip': already known unchanged, or older than the current cutoff (backfill)
 *
 * `existing.content_hash === null` (legacy items pre-dating the content_hash
 * column) is treated as 'skip' so the migration doesn't trigger a flood of
 * spurious 'updated' notifications on the first refresh.
 */
export function classifyFeedItem(args: {
    contentHash: string
    itemDate: Date | null
    existing: FeedItemFingerprint | undefined
    maxDate: Date | null
}): FeedItemClassification {
    const {contentHash, itemDate, existing, maxDate} = args
    if (!existing) {
        if (itemDate && (!maxDate || itemDate.getTime() > maxDate.getTime())) {
            return 'new'
        }
        return 'skip'
    }
    if (existing.content_hash !== null && existing.content_hash !== contentHash) {
        return 'updated'
    }
    return 'skip'
}

export async function refreshFeed(feedGuid: string, env: Env, ctx?: ExecutionContext) {
    const db = env.DB
    const cache_bucket = env.RSS_CACHE_BUCKET
    const feed = await ServerFeed.get(db, feedGuid)
    const feedSources = await getUpdatableFeedSources(db, feedGuid)

    if (!feed) {
        return
    }

    // Cutoff date for the new/backfill classifier. Raised in memory after each
    // source so items persisted earlier in the same refresh aren't re-classified
    // as 'new' by a later source.
    let maxDate = await getFeedMaxItemDate(db, feedGuid)

    // Fetched lazily on the first feed source that produces notifiable items.
    let pushContext: PushFanOutContext | null | undefined

    for (const feedSource of feedSources) {
        const fetchResult = await fetchRssFile(feedSource.feed_url)
        if (fetchResult.status === 'error') {
            // unable to fetch result from url, or content is not parseable
            continue
        }

        const existingFeedFile = await ServerFeedFile.getByContentHash(db, fetchResult.metadata.sha256Hash)
        if (existingFeedFile) {
            // exact file has been retrieved before, this source has no updates
            continue
        }

        // create and cache feed file
        const feedFile = await createFeedFile(feedSource, fetchResult)
        await feedFile.persistTo(db, cache_bucket)

        const {items} = parseRssText(fetchResult.content)

        // TODO update feed metadata, description, etc from channel

        const fingerprints = await getFeedItemFingerprintsByGuids(
            db, feedGuid, items.map(i => i.guid),
        )

        // classify items (new / updated / backfill / unchanged) before persisting
        const classified = await Promise.all(items.map(async item => {
            const content_hash = await computeFeedItemContentHash(item)
            const itemDate = item.date ? new Date(item.date) : null
            const kind = classifyFeedItem({
                contentHash: content_hash,
                itemDate,
                existing: fingerprints.get(item.guid),
                maxDate,
            })
            return {item, content_hash, itemDate, kind}
        }))

        // persist items (existing behavior preserved)
        await Promise.allSettled(classified.map(async ({item, content_hash}) => {
            const entity = await createFeedItem(feed, item, content_hash)
            return entity.persistTo(db)
        }))

        // raise the cutoff so a later source in the same refresh doesn't
        // re-classify what we just persisted as 'new'
        for (const {itemDate} of classified) {
            if (itemDate && (!maxDate || itemDate.getTime() > maxDate.getTime())) {
                maxDate = itemDate
            }
        }

        if (!feed.notify_enabled) continue

        const notifiable = classified.filter(c => c.kind !== 'skip')
        if (notifiable.length === 0) continue

        if (pushContext === undefined) {
            pushContext = await loadPushFanOutContext(env)
        }

        for (const {item, kind} of notifiable) {
            const type = kind === 'new' ? 'new_item' : 'updated_item'
            await createNotification(db, type, feed.guid, item.guid)

            if (!pushContext) continue

            const payload: PushNotificationPayload = {
                type,
                feed_guid: feed.guid,
                feed_item_guid: item.guid,
                title: feed.alias || feed.title,
                body: kind === 'new' ? item.title : `Updated: ${item.title}`,
                url: `/feeditem/${encodeURIComponent(item.guid)}`,
            }
            const fanOut = fanOutPushWithContext(db, pushContext, payload)
            if (ctx) {
                ctx.waitUntil(fanOut)
            } else {
                await fanOut
            }
        }
    }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS

export async function planFeedArchives(feedGuid: string, env: Env) {
    const db = env.DB
    const feed = await ServerFeed.get(db, feedGuid)
    if (!feed) return

    const feedSources = await feed.feedSources(db)

    // if any archive sources exist, archives have already been planned
    if (feedSources.some(s => s.archive)) return

    const nonArchiveSources = feedSources.filter(s => !s.archive)
    if (nonArchiveSources.length === 0) return

    // compute average fetch interval from feed files
    const feedFiles = await getFeedFilesForFeed(db, feedGuid)
    let intervalMs: number

    if (feedFiles.length > 1) {
        const timestamps = feedFiles.map(f => f.fetched_at.getTime())
        let totalGap = 0
        for (let i = 1; i < timestamps.length; i++) {
            totalGap += timestamps[i] - timestamps[i - 1]
        }
        intervalMs = totalGap / (timestamps.length - 1) / 2
    } else {
        const dateRange = await getFeedItemDateRange(db, feedGuid)
        intervalMs = dateRange
            ? (dateRange.latest.getTime() - dateRange.earliest.getTime()) / 2
            : THIRTY_DAYS_MS
    }

    // clamp interval to [1 day, 30 days]
    intervalMs = Math.max(ONE_DAY_MS, Math.min(THIRTY_DAYS_MS, intervalMs))

    for (const feedSource of nonArchiveSources) {
        const snapshots = await fetchArchiveList(feedSource.feed_url)
        if (snapshots.length === 0) continue

        const selected = selectSnapshots(snapshots, intervalMs)

        for (const snapshot of selected) {
            const snapshotUrl = waybackSnapshotUrl(snapshot.timestamp, snapshot.original)
            await env.FEED_PROCESSING_QUEUE.send({
                type: 'fetch-archive-snapshot',
                feedSourceUrl: feedSource.feed_url,
                feedGuid,
                timestamp: snapshot.timestamp,
                snapshotUrl,
            } satisfies FetchArchiveSnapshotTask)
        }
    }
}

interface Snapshot {
    timestamp: number
    original: string
    digest: string
}

export function selectSnapshots(snapshots: Snapshot[], intervalMs: number): Snapshot[] {
    if (snapshots.length === 0) return []
    if (snapshots.length === 1) return [...snapshots]

    const selected = new Set<number>()

    // always include first and last
    selected.add(0)
    selected.add(snapshots.length - 1)

    // walk through and select at interval spacing
    let lastSelectedIdx = 0
    for (let i = 1; i < snapshots.length; i++) {
        const lastTs = waybackTimestampToMs(snapshots[lastSelectedIdx].timestamp)
        const currentTs = waybackTimestampToMs(snapshots[i].timestamp)

        if (currentTs - lastTs >= intervalMs) {
            selected.add(i)
            lastSelectedIdx = i
        }
    }

    // gap handling: if gap between consecutive snapshots exceeds interval,
    // include both sides of the gap
    for (let i = 1; i < snapshots.length; i++) {
        const prevTs = waybackTimestampToMs(snapshots[i - 1].timestamp)
        const currTs = waybackTimestampToMs(snapshots[i].timestamp)

        if (currTs - prevTs > intervalMs) {
            selected.add(i - 1)
            selected.add(i)
        }
    }

    return [...selected].sort((a, b) => a - b).map(i => snapshots[i])
}

/** Convert a wayback timestamp (YYYYMMDDHHMMSS) to ms-epoch */
export function waybackTimestampToMs(timestamp: number): number {
    const s = String(timestamp)
    const year = s.slice(0, 4)
    const month = s.slice(4, 6)
    const day = s.slice(6, 8)
    const hour = s.slice(8, 10) || '00'
    const min = s.slice(10, 12) || '00'
    const sec = s.slice(12, 14) || '00'
    return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`).getTime()
}

export async function fetchArchiveSnapshot(task: FetchArchiveSnapshotTask, env: Env) {
    const db = env.DB
    const cache_bucket = env.RSS_CACHE_BUCKET

    const feed = await ServerFeed.get(db, task.feedGuid)
    if (!feed) return

    // fetch snapshot content
    let response: Response
    try {
        response = await fetch(task.snapshotUrl)
    } catch {
        console.log(`Failed to fetch archive snapshot: ${task.snapshotUrl}`)
        return
    }

    if (!response.ok) {
        console.log(`Archive snapshot returned ${response.status}: ${task.snapshotUrl}`)
        return
    }

    const content = await response.text()

    // check if content is parseable RSS
    let parsed
    try {
        parsed = parseRssText(content)
    } catch {
        console.log(`Archive snapshot is not valid RSS: ${task.snapshotUrl}`)
        return
    }

    // check for duplicate content
    const contentHash = await sha256Encode(content)
    const existingFile = await ServerFeedFile.getByContentHash(db, contentHash)
    if (existingFile) return

    // create archive feed source if it doesn't exist
    const existingSource = await ServerFeedSource.get(db, task.snapshotUrl)
    if (!existingSource) {
        const archiveSource = new ServerFeedSource({
            feed_url: task.snapshotUrl,
            referenced_feed: task.feedGuid,
            actively_updating: false,
            last_updated: new Date().toISOString(),
            last_fetched: new Date().toISOString(),
            archive: true,
            primary_source: false,
        })
        await archiveSource.persistTo(db)
    }

    // create and persist feed file
    const filename = `cached-file-${await sha256Encode(task.snapshotUrl)}-${task.timestamp}.rss`
    const feedFile = new ServerFeedFile({
        feed_url: task.snapshotUrl,
        fetched_at: new Date().toISOString(),
        referenced_feed: task.feedGuid,
        cached_file: filename,
        sha256_hash: contentHash,
    }, content)
    await feedFile.persistTo(db, cache_bucket)

    // persist feed items (duplicates handled by ON CONFLICT)
    await Promise.allSettled(parsed.items.map(async item => {
        const entity = await createFeedItem(feed, item)
        return entity.defer().persistTo(db)
    }))
}

export const TRANSCRIPT_DEFAULT_MODEL = '@cf/openai/whisper-large-v3-turbo'

const TRANSCRIPT_POLL_DELAY_SEC = 30
// Total wall-clock cap from when batch was submitted before we give up.
const TRANSCRIPT_MAX_AGE_MS = 60 * 60 * 1000  // 1 hour

interface WhisperBatchResult {
    text: string
    transcription_info?: {language?: string}
    segments?: unknown
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

async function whisperSubmitBatch(env: Env, model: string, audioBase64: string, language: string | null) {
    // Whisper's batch input mirrors its sync input — audio/task/language at the
    // root — with queueRequest:true switching env.AI.run into batch mode.
    return await env.AI.run(model as '@cf/openai/whisper-large-v3-turbo', {
        audio: audioBase64,
        task: 'transcribe',
        ...(language ? {language} : {}),
        vad_filter: true,
    }, {queueRequest: true} as never) as unknown as WhisperBatchSubmitResponse
}

async function whisperPollBatch(env: Env, model: string, requestId: string) {
    return await env.AI.run(model as '@cf/openai/whisper-large-v3-turbo', {
        request_id: requestId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as unknown as WhisperBatchPollResponse
}

async function reenqueueTranscriptPoll(env: Env, transcriptId: number) {
    await env.FEED_PROCESSING_QUEUE.send(
        {type: 'transcribe-feed-item', transcriptId} as const,
        {delaySeconds: TRANSCRIPT_POLL_DELAY_SEC},
    )
}

/**
 * Two-phase transcription using the Workers AI Batch API:
 *   - pending  -> download audio, submit batch, record request_id, re-enqueue
 *   - processing -> poll batch; on completion persist text, else re-enqueue
 * Whisper inference for podcast-length audio exceeds the synchronous AI.run
 * timeout (504), which is why we go through batch.
 */
export async function transcribeFeedItem(transcriptId: number, env: Env) {
    const db = env.DB
    const transcript = await ServerTranscript.get(db, transcriptId)
    if (!transcript) return
    if (transcript.status === 'complete' || transcript.status === 'error') return

    const feedItem = await ServerFeedItem.get(db, transcript.feed_item_guid)
    if (!feedItem?.enclosure_url) {
        await updateTranscriptStatus(db, transcriptId, {
            status: 'error',
            error_message: 'Feed item has no enclosure_url',
            completed_at: new Date().toISOString(),
        })
        return
    }

    if (transcript.status === 'pending') {
        try {
            const upstream = await fetch(feedItem.enclosure_url, {
                headers: {'User-Agent': FETCH_USER_AGENT},
            })
            if (!upstream.ok) throw new Error(`Upstream fetch failed: HTTP ${upstream.status}`)
            const audioBuf = await upstream.arrayBuffer()
            const audioBase64 = Buffer.from(audioBuf).toString('base64')

            const submitted = await whisperSubmitBatch(env, transcript.model, audioBase64, transcript.language)
            if (!submitted.request_id) {
                throw new Error('Batch submission returned no request_id')
            }

            await updateTranscriptStatus(db, transcriptId, {
                status: 'processing',
                started_at: new Date().toISOString(),
                batch_request_id: submitted.request_id,
            })
            await reenqueueTranscriptPoll(env, transcriptId)
        } catch (err) {
            await updateTranscriptStatus(db, transcriptId, {
                status: 'error',
                error_message: err instanceof Error ? err.message : String(err),
                completed_at: new Date().toISOString(),
            })
        }
        return
    }

    // status === 'processing'
    if (!transcript.batch_request_id) {
        await updateTranscriptStatus(db, transcriptId, {
            status: 'error',
            error_message: 'Processing transcript has no batch_request_id',
            completed_at: new Date().toISOString(),
        })
        return
    }
    if (transcript.started_at && Date.now() - transcript.started_at.getTime() > TRANSCRIPT_MAX_AGE_MS) {
        await updateTranscriptStatus(db, transcriptId, {
            status: 'error',
            error_message: 'Timed out waiting for Whisper batch result',
            completed_at: new Date().toISOString(),
        })
        return
    }

    try {
        const poll = await whisperPollBatch(env, transcript.model, transcript.batch_request_id)
        const arrayResponse = poll.responses?.[0]
        const result = arrayResponse?.result ?? poll.result
        const success = arrayResponse?.success ?? poll.success
        const error = arrayResponse?.error ?? poll.error

        if (result && (success ?? true)) {
            const detectedLanguage = result.transcription_info?.language ?? transcript.language ?? null
            const segments = result.segments ?? null
            await updateTranscriptStatus(db, transcriptId, {
                status: 'complete',
                text: result.text,
                segments_json: segments ? JSON.stringify(segments) : null,
                language: detectedLanguage,
                completed_at: new Date().toISOString(),
            })
            await feedItem.refreshTextSearch(db)
        } else if (success === false || error) {
            await updateTranscriptStatus(db, transcriptId, {
                status: 'error',
                error_message: error ? JSON.stringify(error) : 'Inference failed',
                completed_at: new Date().toISOString(),
            })
        } else {
            // Still queued/running — poll again later.
            await reenqueueTranscriptPoll(env, transcriptId)
        }
    } catch (err) {
        // Treat transient poll failures as retriable up to the max-age cap above.
        console.error('[transcribe] poll error', err)
        await reenqueueTranscriptPoll(env, transcriptId)
    }
}
