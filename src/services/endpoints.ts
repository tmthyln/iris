import type {D1Database} from '@cloudflare/workers-types';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validator } from 'hono/validator';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
    ClientFeed,
    ClientFeedItemPreview,
    ClientTranscript,
    ClientTranscriptFull,
    ServerFeed,
    ServerFeedSource,
    ClientFeedItem,
    ServerFeedItem,
    ServerFeedFile,
    ServerTranscript,
} from './models'
import {
    createFeed,
    createFeedItem,
    createFeedSource,
    createTranscriptRequest,
    getActiveTranscriptRequest,
    getFeeds,
    getBookmarkedFeedItems,
    getFeedItems,
    getFeedItemsForFeed,
    createFeedFile,
    listTranscriptsForItem,
    searchFeedItems,
    getAdjacentFeedItems,
    getNotifications,
    getUnreadNotificationCount,
    dismissNotification,
    dismissAllNotifications,
    upsertPushSubscription,
    deletePushSubscription,
    countPushSubscriptions,
} from './crud'
import type { RefreshFeedTask, PlanFeedArchivesTask, TranscribeFeedItemTask } from "./types";
import {fetchRssFile, parseRssText, FETCH_USER_AGENT} from "./utils/files";
import {fanOutPushWithContext, loadPushFanOutContext} from "./utils/push";
import {getQueue} from "./queue";
import {refreshFeed, TRANSCRIPT_DEFAULT_MODEL} from "./flows";

type Bindings = {Bindings: Env}

/******************************************************************************
 * Validation helpers
 *
 * Request bodies and query strings go through hono/validator so the route
 * types (and therefore the RPC client) know the accepted inputs. A validator
 * returns either the parsed value or an error response.
 *****************************************************************************/

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** First value of a query parameter (repeated parameters arrive as arrays). */
function queryValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value
}

function queryInt(value: string | string[] | undefined): number | undefined {
    const raw = queryValue(value)
    if (raw === undefined) return undefined
    const parsed = parseInt(raw)
    return Number.isFinite(parsed) ? parsed : undefined
}

function queryBool(value: string | string[] | undefined): boolean | undefined {
    const raw = queryValue(value)
    return raw === 'true' ? true : raw === 'false' ? false : undefined
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// Routes are chained (and composed with .route() below) so the app's type carries the full route
// schema: src/types.ts and src/client.ts derive the frontend's DTO and request types from AppType.

// Errors are returned as JSON bodies ({error: string}) rather than statusText:
// HTTP/2 does not transmit reason phrases, so statusText is invisible in production.
// The status is generic so each error status stays distinct from 200 in the route's response type.
function apiError<S extends ContentfulStatusCode>(c: Context, status: S, error: string) {
    return c.json({error}, status)
}


/******************************************************************************
 * Search endpoint
 *****************************************************************************/

const searchRoutes = new Hono<Bindings>()
    .get('/search', validator('query', (value): {q: string, limit?: number, offset?: number} => ({
        q: queryValue(value.q)?.trim() ?? '',
        limit: queryInt(value.limit),
        offset: queryInt(value.offset),
    })), async (c) => {
        const {q: query, limit = 20, offset = 0} = c.req.valid('query')
        if (query.length < 3) {
            return c.json([], 200)
        }

        const results = await searchFeedItems(c.env.DB, query, { limit, offset })

        return c.json(results.map(item => new ClientFeedItemPreview(item)), 200)
    })

/******************************************************************************
 * Feed endpoints
 *****************************************************************************/

const feedRoutes = new Hono<Bindings>()
    .get('/feed', async (c) => {
        const feeds = await getFeeds(c.env.DB)

        return c.json(feeds.map(feed => new ClientFeed(feed)), 200)
    })
    .post('/feed', validator('json', (value: unknown, c) => {
        const url = isRecord(value) ? optionalString(value.url) : undefined
        if (!url) return apiError(c, 400, 'url is required')
        return {url}
    }), async (c) => {
        const db = c.env.DB;
        const cache_bucket = c.env.RSS_CACHE_BUCKET;
        const queue = c.env.FEED_PROCESSING_QUEUE;
        const {url: inputUrl} = c.req.valid('json')

        // fetch live content from input url
        const fetchResult = await fetchRssFile(inputUrl)
        if (fetchResult.status === 'error') {
            const messages: Record<string, string> = {
                'blocked-by-bot-protection': 'URL is protected by bot detection. Try providing the direct RSS feed URL instead.',
                'no-rss-link-found': 'No RSS feed found at the provided URL.',
            }
            const message = messages[fetchResult.reason] ?? 'Provided URL was not accessible.'
            return apiError(c, 502, message)
        }
        const {content, metadata} = fetchResult

        // look up feed source by URL,
        const existingFeedSource = await ServerFeedSource.get(db, metadata.requestUrl)
        if (existingFeedSource) {
            await queue.send({
                type: 'refresh-feed',
                feedGuid: existingFeedSource.referenced_feed,
            } satisfies RefreshFeedTask)

            await queue.send({
                type: 'plan-feed-archives',
                feedGuid: existingFeedSource.referenced_feed,
            } satisfies PlanFeedArchivesTask)

            return c.json({message: 'Feed already exists, refreshing feed...'}, 202)
        }

        // extract feed info and feed items
        const {channel, items} = parseRssText(content)

        // look up feed file by hash
        const existingFeedFile = await ServerFeedFile.getByContentHash(db, metadata.sha256Hash)
        if (existingFeedFile) {
            const existingFeed = await ServerFeed.get(db, existingFeedFile.referenced_feed) as ServerFeed
            const newFeedSource = createFeedSource(existingFeed, channel, fetchResult)
            await newFeedSource.persistTo(db)
        }

        // resolve feed
        const feed = await ServerFeed.get(db, channel.guid)
            ?? await createFeed(channel, fetchResult, inputUrl).persistTo(db)

        // new feed source
        const feedSource = createFeedSource(feed, channel, fetchResult)
        await feedSource.persistTo(db)

        // create and cache feed file
        const feedFile = await createFeedFile(feedSource, fetchResult)
        await feedFile.persistTo(db, cache_bucket)

        // non-duplicate feed items
        await Promise.allSettled(items.map(async item => {
            const entity = await createFeedItem(feed, item)
            return entity.persistTo(db)
        }))

        await queue.send({
            type: 'plan-feed-archives',
            feedGuid: feed.guid,
        } satisfies PlanFeedArchivesTask)

        return c.json({message: 'Feed loaded.'}, 200)
    })
    .get('/feed/:guid', async (c) => {
        const feedGuid = c.req.param('guid')

        const feed = await ServerFeed.get(c.env.DB, feedGuid)

        return feed ? c.json(new ClientFeed(feed), 200) : apiError(c, 404, `No feed found with guid: ${feedGuid}`)
    })
    .patch('/feed/:guid', validator('json', (value: unknown, c) => {
        if (!isRecord(value)) return apiError(c, 400, 'Request body must be a JSON object')
        for (const key of Object.keys(value)) {
            if (!['categories', 'alias', 'notify_enabled'].includes(key)) {
                return apiError(c, 422, `Cannot update the feed field: ${key}`)
            }
        }
        const update: {categories?: string[], alias?: string, notify_enabled?: boolean} = {}
        if ('categories' in value) {
            if (!isStringArray(value.categories)) {
                return apiError(c, 422, 'categories must be a list of strings')
            }
            if (value.categories.some(category => category.includes(','))) {
                return apiError(c, 422, 'Category names cannot contain commas')
            }
            update.categories = value.categories
        }
        if ('alias' in value) {
            update.alias = optionalString(value.alias) ?? ''
        }
        if ('notify_enabled' in value) {
            update.notify_enabled = Boolean(value.notify_enabled)
        }
        return update
    }), async (c) => {
        const data = c.req.valid('json')
        const feedGuid = c.req.param('guid')
        const db = c.env.DB

        const updateData: Record<string, unknown> = {}
        if (data.categories !== undefined) {
            updateData.categories = data.categories.join(',')
        }
        if (data.alias !== undefined) {
            updateData.alias = data.alias
        }
        if (data.notify_enabled !== undefined) {
            updateData.notify_enabled = data.notify_enabled ? 1 : 0
        }

        if (Object.keys(updateData).length === 0) {
            return c.body(null, 200)
        }

        await db
            .prepare(`
                UPDATE feed
                SET ${Object.keys(updateData).map(key => `${key} = ?`).join(', ')}
                WHERE guid = ?`)
            .bind(...Object.values(updateData), feedGuid)
            .run()

        return c.body(null, 200)
    })
    .get('/feed/:guid/feeditem', validator('query', (value): {include_finished?: boolean, sort_order?: 'asc' | 'desc', limit?: number, offset?: number} => {
        const sortOrder = queryValue(value.sort_order)
        return {
            include_finished: queryBool(value.include_finished),
            sort_order: sortOrder === 'asc' || sortOrder === 'desc' ? sortOrder : undefined,
            limit: queryInt(value.limit),
            offset: queryInt(value.offset),
        }
    }), async (c) => {
        const feedGuid = c.req.param('guid')
        const {include_finished, sort_order, limit, offset} = c.req.valid('query')

        const feedItems = await getFeedItemsForFeed(c.env.DB, feedGuid, {
            includeFinished: include_finished,
            sortOrder: sort_order,
            limit,
            offset,
        })

        return c.json(feedItems.map(item => new ClientFeedItem(item)), 200)
    })

/******************************************************************************
 * Feed item endpoints
 *****************************************************************************/

const feedItemRoutes = new Hono<Bindings>()
    .get('/feeditem', validator('query', (value): {bookmarked?: boolean, limit?: number, offset?: number} => ({
        bookmarked: queryBool(value.bookmarked),
        limit: queryInt(value.limit),
        offset: queryInt(value.offset),
    })), async (c) => {
        const db = c.env.DB;
        const {bookmarked, limit = 20, offset = 0} = c.req.valid('query')

        let feedItems
        if (bookmarked) {
            feedItems = await getBookmarkedFeedItems(db)
        } else {
            feedItems = await getFeedItems(db, {limit, offset})
        }

        return c.json(feedItems.map(item => new ClientFeedItem(item)), 200)
    })
    .get('/feeditem/:guid', async (c) => {
        const guid = c.req.param('guid')

        const feedItem = await ServerFeedItem.get(c.env.DB, guid)

        return feedItem ? c.json(new ClientFeedItem(feedItem), 200) : apiError(c, 404, `No feed item found with guid: ${guid}`)
    })
    .get('/feeditem/:guid/media', async (c) => {
        const guid = c.req.param('guid')
        const feedItem = await ServerFeedItem.get(c.env.DB, guid)
        if (!feedItem?.enclosure_url) {
            return apiError(c, 404, 'Feed item has no media enclosure')
        }

        let upstreamUrl: URL
        try {
            upstreamUrl = new URL(feedItem.enclosure_url)
        } catch {
            return apiError(c, 502, 'Invalid media URL')
        }
        if (upstreamUrl.protocol !== 'http:' && upstreamUrl.protocol !== 'https:') {
            return apiError(c, 502, 'Invalid media URL')
        }

        const upstreamHeaders = new Headers()
        upstreamHeaders.set('user-agent', FETCH_USER_AGENT)
        const range = c.req.header('range')
        if (range) upstreamHeaders.set('range', range)

        const upstream = await fetch(upstreamUrl.toString(), {headers: upstreamHeaders})

        const headers = new Headers()
        for (const name of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'last-modified', 'etag']) {
            const value = upstream.headers.get(name)
            if (value) headers.set(name, value)
        }

        return new Response(upstream.body, {status: upstream.status, headers})
    })
    .get('/feeditem/:guid/transcript', async (c) => {
        const guid = c.req.param('guid')
        const transcripts = await listTranscriptsForItem(c.env.DB, guid)
        return c.json(transcripts.map(t => new ClientTranscript(t)), 200)
    })
    .post('/feeditem/:guid/transcript', validator('json', (value: unknown): {model?: string, language?: string} => ({
        model: isRecord(value) ? optionalString(value.model) : undefined,
        language: isRecord(value) ? optionalString(value.language) : undefined,
    })), async (c) => {
        const guid = c.req.param('guid')
        const body = c.req.valid('json')

        const feedItem = await ServerFeedItem.get(c.env.DB, guid)
        if (!feedItem) {
            return apiError(c, 404, `No feed item found with guid: ${guid}`)
        }
        if (!feedItem.enclosure_url) {
            return apiError(c, 400, 'Feed item has no audio enclosure')
        }

        const model = body.model ?? TRANSCRIPT_DEFAULT_MODEL

        // A transcription job is expensive (full audio download + billed Whisper
        // batch), so an already-active request for this item+model is returned
        // as-is instead of enqueuing a duplicate.
        const existing = await getActiveTranscriptRequest(c.env.DB, guid, model)
        if (existing) {
            return c.json(new ClientTranscript(existing), 200)
        }

        const transcript = await createTranscriptRequest(
            c.env.DB, guid, model, body.language ?? null,
        )

        await c.env.FEED_PROCESSING_QUEUE.send({
            type: 'transcribe-feed-item',
            transcriptId: transcript.id,
        } satisfies TranscribeFeedItemTask)

        return c.json(new ClientTranscript(transcript), 202)
    })
    .get('/transcript/:id', async (c) => {
        const id = parseInt(c.req.param('id'))
        if (!Number.isFinite(id)) {
            return apiError(c, 400, 'Invalid transcript id')
        }
        const transcript = await ServerTranscript.get(c.env.DB, id)
        if (!transcript) {
            return apiError(c, 404, `No transcript found with id: ${id}`)
        }
        return c.json(new ClientTranscriptFull(transcript), 200)
    })
    .get('/feeditem/:guid/adjacent', async (c) => {
        const guid = c.req.param('guid')
        const {prev, next} = await getAdjacentFeedItems(c.env.DB, guid)
        return c.json({
            prev: prev ? new ClientFeedItemPreview(prev) : null,
            next: next ? new ClientFeedItemPreview(next) : null,
        }, 200)
    })
    .patch('/feeditem/:guid', validator('json', (value: unknown, c) => {
        if (!isRecord(value)) return apiError(c, 400, 'Request body must be a JSON object')
        const update: {finished?: boolean, progress?: number, bookmarked?: boolean} = {}
        for (const key of Object.keys(value)) {
            if (!['finished', 'progress', 'bookmarked'].includes(key)) {
                return apiError(c, 422, `Cannot update the feed item field: ${key}`)
            }
        }
        if ('finished' in value) update.finished = Boolean(value.finished)
        if ('progress' in value) {
            const progress = optionalNumber(value.progress)
            if (progress === undefined) return apiError(c, 422, 'progress must be a number')
            update.progress = progress
        }
        if ('bookmarked' in value) update.bookmarked = Boolean(value.bookmarked)
        return update
    }), async (c) => {
        const data = c.req.valid('json')
        const feedItemGuid = c.req.param('guid')
        const db = c.env.DB

        const updateData: Record<string, unknown> = {}
        if (data.finished !== undefined) updateData.finished = data.finished
        if (data.progress !== undefined) updateData.progress = data.progress
        if (data.bookmarked !== undefined) updateData.bookmarked = data.bookmarked

        if (Object.keys(updateData).length === 0) {
            return c.body(null, 200)
        }

        await db
            .prepare(`
                UPDATE feed_item 
                SET ${Object.keys(updateData).map(key => `${key} = ?`).join(', ')}
                WHERE guid = ?`)
            .bind(...Object.values(updateData), feedItemGuid)
            .run()

        return c.body(null, 200)
    })

/******************************************************************************
 * Queue endpoints
 *****************************************************************************/

async function hydrateQueueItems(db: D1Database, guids: string[]) {
    const items = await Promise.all(guids.map(guid => ServerFeedItem.get(db, guid)))
    return items
        .filter((item): item is ServerFeedItem => item !== null)
        .map(item => new ClientFeedItemPreview(item))
}

const queueRoutes = new Hono<Bindings>()
    .get('/queue', async (c) => {
        const queue = getQueue(c.env)
        const guids = await queue.getItems()
        return c.json({items: await hydrateQueueItems(c.env.DB, guids)}, 200)
    })
    .post('/queue', validator('json', (value: unknown, c) => {
        const feedItemId = isRecord(value) ? optionalString(value.feedItemId) : undefined
        if (!feedItemId) return apiError(c, 400, 'feedItemId is required')
        const position = isRecord(value) ? optionalNumber(value.position) : undefined
        return {feedItemId, ...(position !== undefined ? {position} : {})}
    }), async (c) => {
        const db = c.env.DB
        const {feedItemId, position} = c.req.valid('json')

        const feedItem = await ServerFeedItem.get(db, feedItemId)
        if (!feedItem) {
            return apiError(c, 404, `No feed item found with id: ${feedItemId}`)
        }

        const feed = await ServerFeed.get(db, feedItem.source_feed)
        if (feed?.type !== 'podcast') {
            return apiError(c, 400, 'Only podcast feed items can be queued')
        }

        const queue = getQueue(c.env)
        let guids
        if (typeof position === 'number') {
            guids = await queue.insertItem(feedItemId, position)
        } else {
            guids = await queue.enqueueItem(feedItemId)
        }

        return c.json({items: await hydrateQueueItems(db, guids)}, 201)
    })
    .patch('/queue/:guid', validator('json', (value: unknown, c) => {
        const position = isRecord(value) ? optionalNumber(value.position) : undefined
        if (position === undefined) return apiError(c, 400, 'position is required')
        return {position}
    }), async (c) => {
        const feedItemGuid = c.req.param('guid')
        const {position} = c.req.valid('json')

        const queue = getQueue(c.env)
        const guids = await queue.insertItem(feedItemGuid, position)

        return c.json({items: await hydrateQueueItems(c.env.DB, guids)}, 200)
    })
    .delete('/queue/:guid', async (c) => {
        const feedItemGuid = c.req.param('guid')
        const queue = getQueue(c.env)
        const guids = await queue.removeItem(feedItemGuid)

        return c.json({items: await hydrateQueueItems(c.env.DB, guids)}, 200)
    })
    .delete('/queue', validator('query', (value): {keepFirst?: boolean} => ({
        keepFirst: queryBool(value.keepFirst),
    })), async (c) => {
        const {keepFirst = false} = c.req.valid('query')
        const queue = getQueue(c.env)

        let guids: string[] = []
        if (keepFirst) {
            const current = (await queue.getItems())[0]
            await queue.clearQueue()
            if (current) {
                guids = await queue.enqueueItem(current)
            }
        } else {
            guids = await queue.clearQueue()
        }

        return c.json({items: await hydrateQueueItems(c.env.DB, guids)}, 200)
    })

/******************************************************************************
 * Command endpoints
 *****************************************************************************/

const commandRoutes = new Hono<Bindings>()
    .post('/command/refresh-feed/:guid', async (c) => {
        const feedGuid = c.req.param('guid')
        const db = c.env.DB

        const feed = await ServerFeed.get(db, feedGuid)
        if (!feed) return apiError(c, 404, `No feed found with guid: ${feedGuid}`)

        await c.env.FEED_PROCESSING_QUEUE.send({
            type: 'refresh-feed',
            feedGuid,
        } satisfies RefreshFeedTask)

        return c.body(null, 202)
    })
    .post('/command/plan-feed-archives/:guid', async (c) => {
        const feedGuid = c.req.param('guid')
        const db = c.env.DB

        const feed = await ServerFeed.get(db, feedGuid)
        if (!feed) return apiError(c, 404, `No feed found with guid: ${feedGuid}`)

        await c.env.FEED_PROCESSING_QUEUE.send({
            type: 'plan-feed-archives',
            feedGuid,
        } satisfies PlanFeedArchivesTask)

        return c.body(null, 202)
    })
    .post('/command/refresh-all-feeds', async (c) => {
        const feeds = await getFeeds(c.env.DB)

        for (const feed of feeds) {
            await refreshFeed(feed.guid, c.env)
        }
        //await Promise.all(feeds.map(feed => refreshFeed(feed.guid, c.env)))

        return c.json({refreshedCount: feeds.length}, 200)
    })

/******************************************************************************
 * Notification endpoints
 *****************************************************************************/

const notificationRoutes = new Hono<Bindings>()
    .get('/notification', validator('query', (value): {include_dismissed?: boolean, limit?: number} => ({
        include_dismissed: queryBool(value.include_dismissed),
        limit: queryInt(value.limit),
    })), async (c) => {
        const db = c.env.DB
        const {include_dismissed: includeDismissed = false, limit: requested = 50} = c.req.valid('query')
        const limit = Math.max(1, Math.min(200, requested))

        const [items, unreadCount] = await Promise.all([
            getNotifications(db, {limit, includeDismissed}),
            getUnreadNotificationCount(db),
        ])

        return c.json({items, unreadCount}, 200)
    })
    .delete('/notification/:id', async (c) => {
        const id = parseInt(c.req.param('id'))
        if (!Number.isFinite(id)) {
            return apiError(c, 400, 'Invalid notification id')
        }
        await dismissNotification(c.env.DB, id)
        return c.body(null, 200)
    })
    .delete('/notification', async (c) => {
        await dismissAllNotifications(c.env.DB)
        return c.body(null, 200)
    })

/******************************************************************************
 * Push subscription endpoints
 *****************************************************************************/

// Hosts of the major web-push services. Endpoints from any other host are
// rejected to keep this open endpoint from being used to register
// attacker-controlled URLs that the worker would later POST to.
const PUSH_SERVICE_HOST_PATTERNS: RegExp[] = [
    /(?:^|\.)push\.services\.mozilla\.com$/i, // Firefox / Mozilla autopush
    /^fcm\.googleapis\.com$/i,                // Chrome / Edge (FCM)
    /(?:^|\.)notify\.windows\.com$/i,         // Edge (WNS)
    /(?:^|\.)push\.apple\.com$/i,             // Safari (APNs)
    /(?:^|\.)pushservice\.google\.com$/i,     // legacy Chrome / GCM
]

const MAX_PUSH_SUBSCRIPTIONS = 50
const MAX_PUSH_FIELD_LENGTH = 2048

function validatePushEndpoint(endpoint: string): string | null {
    if (endpoint.length > MAX_PUSH_FIELD_LENGTH) return 'endpoint is too long'
    let url: URL
    try {
        url = new URL(endpoint)
    } catch {
        return 'endpoint is not a valid URL'
    }
    if (url.protocol !== 'https:') return 'endpoint must be https'
    if (!PUSH_SERVICE_HOST_PATTERNS.some(re => re.test(url.hostname))) {
        return 'endpoint host is not a recognized push service'
    }
    return null
}

const pushRoutes = new Hono<Bindings>()
    .get('/push/vapid-public-key', (c) => {
        const env = c.env as unknown as {VAPID_PUBLIC_KEY?: string}
        const key = env.VAPID_PUBLIC_KEY ?? ''
        if (!key) {
            return apiError(c, 503, 'Push notifications not configured')
        }
        return c.json({key}, 200)
    })
    .post('/push/subscription', validator('json', (value: unknown, c) => {
        const endpoint = isRecord(value) ? optionalString(value.endpoint) : undefined
        const keys = isRecord(value) && isRecord(value.keys) ? value.keys : undefined
        const p256dh = keys ? optionalString(keys.p256dh) : undefined
        const auth = keys ? optionalString(keys.auth) : undefined
        if (!endpoint || !p256dh || !auth) {
            return apiError(c, 400, 'endpoint, keys.p256dh, and keys.auth are required')
        }
        return {endpoint, keys: {p256dh, auth}}
    }), async (c) => {
        const {endpoint, keys} = c.req.valid('json')
        const endpointError = validatePushEndpoint(endpoint)
        if (endpointError) {
            return apiError(c, 400, endpointError)
        }
        if (keys.p256dh.length > MAX_PUSH_FIELD_LENGTH || keys.auth.length > MAX_PUSH_FIELD_LENGTH) {
            return apiError(c, 400, 'subscription key is too long')
        }

        // Cap the table to prevent unbounded growth from an unauthenticated endpoint.
        // Existing rows can still be updated (re-subscription with the same endpoint).
        const existing = await countPushSubscriptions(c.env.DB)
        if (existing >= MAX_PUSH_SUBSCRIPTIONS) {
            // Check whether this is an update to an existing row before rejecting.
            const isUpdate = await c.env.DB
                .prepare('SELECT 1 FROM push_subscription WHERE endpoint = ?')
                .bind(endpoint)
                .first()
            if (!isUpdate) {
                return apiError(c, 429, 'subscription cap reached')
            }
        }

        await upsertPushSubscription(c.env.DB, endpoint, keys.p256dh, keys.auth)
        return c.body(null, 201)
    })
    .delete('/push/subscription', validator('json', (value: unknown): {endpoint?: string} => ({
        endpoint: isRecord(value) ? optionalString(value.endpoint) : undefined,
    })), async (c) => {
        const endpoint = c.req.valid('json').endpoint ?? c.req.query('endpoint')
        if (!endpoint) {
            return apiError(c, 400, 'endpoint is required')
        }
        await deletePushSubscription(c.env.DB, endpoint)
        return c.body(null, 200)
    })
    .post('/push/test', validator('json', (value: unknown): {endpoint?: string} => ({
        endpoint: isRecord(value) ? optionalString(value.endpoint) : undefined,
    })), async (c) => {
        const data = c.req.valid('json')

        const context = await loadPushFanOutContext(c.env)
        if (!context) {
            return apiError(c, 503, 'Push not configured or no subscribers')
        }

        const subscriptions = data.endpoint
            ? context.subscriptions.filter(s => s.endpoint === data.endpoint)
            : context.subscriptions
        if (subscriptions.length === 0) {
            return apiError(c, 404, 'No matching subscription')
        }

        await fanOutPushWithContext(c.env.DB, {...context, subscriptions}, {
            type: 'new_item',
            feed_guid: '',
            feed_item_guid: '',
            title: 'Iris',
            body: 'Test notification — push is working.',
            url: '/',
        })
        return c.body(null, 204)
    })

/******************************************************************************
 * App
 *****************************************************************************/

export const app = new Hono<Bindings>()
    .basePath('/api')
    .route('/', searchRoutes)
    .route('/', feedRoutes)
    .route('/', feedItemRoutes)
    .route('/', queueRoutes)
    .route('/', commandRoutes)
    .route('/', notificationRoutes)
    .route('/', pushRoutes)

app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({error: err.message}, err.status)
    console.error('Unhandled API error:', err)
    if (err instanceof SyntaxError) return c.json({error: 'Invalid JSON in request body'}, 400)
    return c.json({error: 'Internal server error'}, 500)
})
app.notFound((c) => c.json({error: 'Not found'}, 404))

export type AppType = typeof app
