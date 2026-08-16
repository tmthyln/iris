import type {D1Database} from "@cloudflare/workers-types";
import {RawFeed, RawFeedFile, RawFeedItem, RawFeedSource, RawTranscript, ServerFeed, ServerFeedFile, ServerFeedItem, ServerFeedSource, ServerNotification, ServerPushSubscription, ServerTranscript, RawNotification, RawPushSubscription, NotificationType, ClientNotification, TranscriptStatus} from "./models";
import {ChannelData, ChannelItemData, computeFeedItemContentHash, sha256Encode} from "./utils/files";
import {FetchSuccessFileResult} from "./types";

export async function getAdjacentFeedItems(db: D1Database, guid: string) {
    const current = await db
        .prepare('SELECT source_feed, date FROM feed_item WHERE guid = ?')
        .bind(guid)
        .first<{source_feed: string, date: string | null}>()

    if (!current?.date) return {prev: null, next: null}

    const [prevRaw, nextRaw] = await Promise.all([
        db.prepare('SELECT * FROM feed_item WHERE source_feed = ? AND date < ? ORDER BY date DESC LIMIT 1')
            .bind(current.source_feed, current.date)
            .first<RawFeedItem>(),
        db.prepare('SELECT * FROM feed_item WHERE source_feed = ? AND date > ? ORDER BY date ASC LIMIT 1')
            .bind(current.source_feed, current.date)
            .first<RawFeedItem>(),
    ])

    return {
        prev: prevRaw ? new ServerFeedItem(prevRaw) : null,
        next: nextRaw ? new ServerFeedItem(nextRaw) : null,
    }
}

export interface SearchFeedItemsOptions {
    limit?: number
    offset?: number
}

export async function searchFeedItems(db: D1Database, query: string, options: SearchFeedItemsOptions = {}) {
    const { limit = 20, offset = 0 } = options
    // Restrict to relevant columns; wrap in quotes for phrase/substring search
    const ftsQuery = '{title alias description author content} : "' + query.replace(/"/g, '""') + '"'

    const { results } = await db
        .prepare(`
            SELECT fi.*
            FROM text_search
            JOIN feed_item fi ON text_search.guid = fi.guid
            WHERE text_search MATCH ?
            ORDER BY rank
            LIMIT ? OFFSET ?
        `)
        .bind(ftsQuery, limit, offset)
        .all<RawFeedItem>()

    return results.map(item => new ServerFeedItem(item))
}

/******************************************************************************
 * Read-only queries
 *****************************************************************************/

export async function getFeeds(db: D1Database) {
    const { results } = await db
        .prepare(`
            SELECT feed.*,
                   MAX(CASE WHEN feed_item.finished = FALSE THEN 1 ELSE 0 END) AS has_unread,
                   EXISTS(SELECT 1 FROM feed_source WHERE referenced_feed = feed.guid AND archive = TRUE) AS has_archives
            FROM feed
            LEFT JOIN feed_item ON feed_item.source_feed = feed.guid
            WHERE feed.active = TRUE
            GROUP BY feed.guid
            ORDER BY MAX(feed_item.date) DESC`)
        .all<RawFeed>()

    return results.map(item => new ServerFeed(item))
}

export async function getUpdatableFeedSources(db: D1Database, feedGuid: string) {
    const { results } = await db
        .prepare(`
            SELECT feed_source.* FROM feed_source
            WHERE referenced_feed = ? AND actively_updating = true AND archive = false
        `)
        .bind(feedGuid)
        .all<RawFeedSource>()

    return results.map(item => new ServerFeedSource(item))
}

interface GetFeedItemsOptions {
    sortOrder?: 'asc' | 'desc'
    limit?: number
    offset?: number
}

export async function getFeedItems(db: D1Database, options: GetFeedItemsOptions = {}) {
    const {
        sortOrder = 'desc',
        limit = 20,
        offset = 0,
    } = options

    const {results} = await db
        .prepare(`
            SELECT feed_item.* FROM feed_item
            JOIN feed ON feed_item.source_feed = feed.guid
            WHERE feed.active = TRUE AND feed_item.finished = FALSE
            ORDER BY feed_item.date ${sortOrder.toUpperCase()}
            LIMIT ? OFFSET ?`)
        .bind(limit, offset)
        .all<RawFeedItem>()

    return results.map(item => new ServerFeedItem(item))
}

export async function getFeedFilesForFeed(db: D1Database, feedGuid: string) {
    const { results } = await db
        .prepare(`
            SELECT * FROM feed_file
            WHERE referenced_feed = ?
            ORDER BY fetched_at ASC
        `)
        .bind(feedGuid)
        .all<RawFeedFile>()

    return results.map(item => new ServerFeedFile(item))
}

export interface FeedItemFingerprint {
    date: Date | null
    content_hash: string | null
}

/**
 * Latest known item date for a feed; used as the cutoff for the "new" vs
 * "backfill" classifier during refresh.
 */
export async function getFeedMaxItemDate(db: D1Database, feedGuid: string) {
    const row = await db
        .prepare(`SELECT MAX(date) AS latest FROM feed_item WHERE source_feed = ? AND date IS NOT NULL`)
        .bind(feedGuid)
        .first<{latest: string | null}>()
    return row?.latest ? new Date(row.latest) : null
}

/**
 * Fetch fingerprints for a specific batch of feed-item GUIDs. Returns only
 * the GUIDs that already exist in the feed. Chunks the IN-list to stay under
 * SQLite's parameter limit.
 */
export async function getFeedItemFingerprintsByGuids(
    db: D1Database,
    feedGuid: string,
    guids: string[],
) {
    const fingerprints = new Map<string, FeedItemFingerprint>()
    if (guids.length === 0) return fingerprints

    const CHUNK = 100
    for (let i = 0; i < guids.length; i += CHUNK) {
        const chunk = guids.slice(i, i + CHUNK)
        const placeholders = chunk.map(() => '?').join(',')
        const {results} = await db
            .prepare(`SELECT guid, date, content_hash FROM feed_item WHERE source_feed = ? AND guid IN (${placeholders})`)
            .bind(feedGuid, ...chunk)
            .all<{guid: string, date: string | null, content_hash: string | null}>()

        for (const row of results) {
            fingerprints.set(row.guid, {
                date: row.date ? new Date(row.date) : null,
                content_hash: row.content_hash,
            })
        }
    }
    return fingerprints
}

export async function getFeedItemDateRange(db: D1Database, feedGuid: string) {
    const result = await db
        .prepare(`
            SELECT MIN(date) AS earliest, MAX(date) AS latest
            FROM feed_item
            WHERE source_feed = ? AND date IS NOT NULL
        `)
        .bind(feedGuid)
        .first<{ earliest: string | null, latest: string | null }>()

    if (!result?.earliest || !result?.latest) return null

    return {
        earliest: new Date(result.earliest),
        latest: new Date(result.latest),
    }
}

export async function getBookmarkedFeedItems(db: D1Database) {
    const {results} = await db
        .prepare(`
            SELECT feed_item.* FROM feed_item
            WHERE feed_item.bookmarked = TRUE
        `)
        .all<RawFeedItem>()

    return results.map(item => new ServerFeedItem(item))
}

/******************************************************************************
 * CUD (modifying queries)
 *****************************************************************************/

export function createFeed(channelData: ChannelData, fetchResult: FetchSuccessFileResult, inputUrl: string) {
    return new ServerFeed({
        guid: channelData.guid,
        input_url: inputUrl,
        source_url: channelData.source_url,
        title: channelData.title,
        alias: '',
        description: channelData.description,
        author: channelData.author,
        type: channelData.type as 'podcast' | 'blog',
        ongoing: true,
        active: true,
        image_src: channelData.image_src,
        image_alt: channelData.image_alt,
        last_updated: channelData.last_updated,
        update_frequency: 1,
        link: channelData.link,
        categories: channelData.categories,
    })
}

export function createFeedSource(feed: ServerFeed, channelData: ChannelData, fetchResult: FetchSuccessFileResult) {
    return new ServerFeedSource({
        feed_url: fetchResult.metadata.requestUrl,
        referenced_feed: feed.guid,
        actively_updating: true,
        last_updated: channelData.last_updated,
        last_fetched: fetchResult.metadata.timestamp,
        archive: false,
        primary_source: false,
    })
}

export async function createFeedFile(
    feedSource: ServerFeedSource, fetchResult: FetchSuccessFileResult,
) {
    const filename = `cached-file-${await sha256Encode(fetchResult.metadata.requestUrl)}-${new Date(fetchResult.metadata.timestamp).getTime()}.rss`

    return new ServerFeedFile({
        feed_url: feedSource.feed_url,
        fetched_at: fetchResult.metadata.timestamp,
        referenced_feed: feedSource.referenced_feed,
        cached_file: filename,
        sha256_hash: fetchResult.metadata.sha256Hash,
    }, fetchResult.content)
}

export async function createFeedItem(feed: ServerFeed, channelItemData: ChannelItemData, contentHash?: string) {
    const content_hash = contentHash ?? await computeFeedItemContentHash(channelItemData)
    return new ServerFeedItem({
        ...channelItemData,
        source_feed: feed.guid,
        finished: false,
        progress: 0,
        content_hash,
    })
}

/******************************************************************************
 * Notifications
 *****************************************************************************/

export async function createNotification(
    db: D1Database,
    type: NotificationType,
    feedGuid: string,
    feedItemGuid: string,
) {
    const notif = new ServerNotification({
        type,
        feed_guid: feedGuid,
        feed_item_guid: feedItemGuid,
        created_at: new Date().toISOString(),
        dismissed: false,
    })
    return notif.persistTo(db)
}

interface GetNotificationsOptions {
    limit?: number
    includeDismissed?: boolean
}

export async function getNotifications(db: D1Database, options: GetNotificationsOptions = {}) {
    const {limit = 50, includeDismissed = false} = options

    const {results} = await db
        .prepare(`
            SELECT n.id, n.type, n.feed_guid, n.feed_item_guid, n.created_at, n.dismissed,
                   f.title AS feed_title, f.alias AS feed_alias,
                   fi.title AS item_title
            FROM notification n
            LEFT JOIN feed f ON n.feed_guid = f.guid
            LEFT JOIN feed_item fi ON n.feed_item_guid = fi.guid
            ${includeDismissed ? '' : 'WHERE n.dismissed = FALSE'}
            ORDER BY n.created_at DESC
            LIMIT ?
        `)
        .bind(limit)
        .all<RawNotification & {feed_title: string | null, feed_alias: string | null, item_title: string | null}>()

    return results.map<ClientNotification>(row => ({
        id: row.id,
        type: row.type,
        feed_guid: row.feed_guid,
        feed_item_guid: row.feed_item_guid,
        feed_title: row.feed_title,
        feed_alias: row.feed_alias,
        item_title: row.item_title,
        created_at: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
        dismissed: Boolean(row.dismissed),
    }))
}

export async function getUnreadNotificationCount(db: D1Database) {
    const row = await db
        .prepare('SELECT COUNT(*) AS count FROM notification WHERE dismissed = FALSE')
        .first<{count: number}>()
    return row?.count ?? 0
}

export async function dismissNotification(db: D1Database, id: number) {
    await db
        .prepare('UPDATE notification SET dismissed = TRUE WHERE id = ?')
        .bind(id)
        .run()
}

export async function dismissAllNotifications(db: D1Database) {
    await db
        .prepare('UPDATE notification SET dismissed = TRUE WHERE dismissed = FALSE')
        .run()
}

/******************************************************************************
 * Transcripts
 *****************************************************************************/

export async function getActiveTranscriptRequest(db: D1Database, feedItemGuid: string, model: string) {
    const row = await db
        .prepare(`
            SELECT * FROM transcript
            WHERE feed_item_guid = ? AND model = ? AND status IN ('pending', 'processing')
            ORDER BY requested_at DESC
            LIMIT 1
        `)
        .bind(feedItemGuid, model)
        .first<RawTranscript>()
    return row ? new ServerTranscript(row) : null
}

export async function createTranscriptRequest(db: D1Database, feedItemGuid: string, model: string, language?: string | null) {
    const requestedAt = new Date().toISOString()
    const result = await db
        .prepare(`
            INSERT INTO transcript (feed_item_guid, model, language, status, requested_at)
            VALUES (?, ?, ?, 'pending', ?)
        `)
        .bind(feedItemGuid, model, language ?? null, requestedAt)
        .run()

    const id = result.meta.last_row_id as number
    return (await ServerTranscript.get(db, id))!
}

export async function listTranscriptsForItem(db: D1Database, feedItemGuid: string) {
    const {results} = await db
        .prepare('SELECT * FROM transcript WHERE feed_item_guid = ? ORDER BY requested_at DESC')
        .bind(feedItemGuid)
        .all<RawTranscript>()
    return results.map(r => new ServerTranscript(r))
}

interface UpdateTranscriptPatch {
    status?: TranscriptStatus
    language?: string | null
    text?: string | null
    segments_json?: string | null
    error_message?: string | null
    batch_request_id?: string | null
    started_at?: string | null
    completed_at?: string | null
}

export async function updateTranscriptStatus(db: D1Database, id: number, patch: UpdateTranscriptPatch) {
    const keys = Object.keys(patch)
    if (keys.length === 0) return
    const assignments = keys.map(k => `${k} = ?`).join(', ')
    const values = keys.map(k => (patch as Record<string, unknown>)[k] ?? null)
    await db
        .prepare(`UPDATE transcript SET ${assignments} WHERE id = ?`)
        .bind(...values, id)
        .run()
}

/******************************************************************************
 * Push subscriptions
 *****************************************************************************/

export async function countPushSubscriptions(db: D1Database) {
    const row = await db
        .prepare('SELECT COUNT(*) AS count FROM push_subscription')
        .first<{count: number}>()
    return row?.count ?? 0
}

export async function getAllPushSubscriptions(db: D1Database) {
    const {results} = await db
        .prepare('SELECT * FROM push_subscription')
        .all<RawPushSubscription>()
    return results.map(row => new ServerPushSubscription(row))
}

export async function upsertPushSubscription(
    db: D1Database, endpoint: string, p256dh: string, auth: string,
) {
    const sub = new ServerPushSubscription({
        endpoint,
        p256dh,
        auth,
        created_at: new Date().toISOString(),
        last_used_at: null,
    })
    await sub.persistTo(db)
    return sub
}

export async function deletePushSubscription(db: D1Database, endpoint: string) {
    await db
        .prepare('DELETE FROM push_subscription WHERE endpoint = ?')
        .bind(endpoint)
        .run()
}

export async function touchPushSubscription(db: D1Database, endpoint: string) {
    await db
        .prepare('UPDATE push_subscription SET last_used_at = ? WHERE endpoint = ?')
        .bind(new Date().toISOString(), endpoint)
        .run()
}
