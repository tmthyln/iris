import {ServerFeed, ServerFeedFile, ServerFeedSource} from "./models";
import {createFeedFile, createFeedItem, getFeedFilesForFeed, getFeedItemDateRange, getUpdatableFeedSources} from "./crud";
import {fetchRssFile, parseRssText, sha256Encode} from "./utils/files";
import {fetchArchiveList, waybackSnapshotUrl} from "./utils/wayback";
import type {FetchArchiveSnapshotTask} from "./types";

export async function refreshFeed(feedGuid: string, env: Env) {
    const db = env.DB
    const cache_bucket = env.RSS_CACHE_BUCKET
    const feed = await ServerFeed.get(db, feedGuid)
    const feedSources = await getUpdatableFeedSources(db, feedGuid)

    if (!feed) {
        return
    }

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

        // non-duplicate feed items
        await Promise.allSettled(items.map(async item =>
            await createFeedItem(feed, item).persistTo(db)
        ))
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
    await Promise.allSettled(parsed.items.map(async item =>
        await createFeedItem(feed, item).defer().persistTo(db)
    ))
}
