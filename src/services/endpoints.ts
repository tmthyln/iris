import type {D1Database} from '@cloudflare/workers-types';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
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
    RawFeedItem
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

export const app = new Hono<{Bindings: Env}>().basePath('/api');

// Errors are returned as JSON bodies ({error: string}) rather than statusText:
// HTTP/2 does not transmit reason phrases, so statusText is invisible in production.
// The status is generic so each error status stays distinct from 200 in the route's response type.
function apiError<S extends ContentfulStatusCode>(c: Context, status: S, error: string) {
    return c.json({error}, status)
}

app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({error: err.message}, err.status)
    console.error('Unhandled API error:', err)
    if (err instanceof SyntaxError) return c.json({error: 'Invalid JSON in request body'}, 400)
    return c.json({error: 'Internal server error'}, 500)
})
app.notFound((c) => c.json({error: 'Not found'}, 404))

/******************************************************************************
 * Search endpoint
 *****************************************************************************/

app.get('/search', async (c) => {
    const query = c.req.query('q')?.trim() ?? ''
    if (query.length < 3) {
        return c.json([], 200)
    }

    const limit = parseInt(c.req.query('limit') ?? '20')
    const offset = parseInt(c.req.query('offset') ?? '0')

    const results = await searchFeedItems(c.env.DB, query, { limit, offset })

    return c.json(results.map(item => new ClientFeedItemPreview(item)), 200)
})

/******************************************************************************
 * Feed endpoints
 *****************************************************************************/

app.get('/feed', async (c) => {
    const feeds = await getFeeds(c.env.DB)

    return c.json(feeds.map(feed => new ClientFeed(feed)), 200)
})
app.post('/feed', async (c) => {
    const db = c.env.DB;
    const cache_bucket = c.env.RSS_CACHE_BUCKET;
    const queue = c.env.FEED_PROCESSING_QUEUE;
    const requestData = await c.req.json() as {url: string}
    const inputUrl = requestData.url;

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
app.get('/feed/:guid', async (c) => {
    const feedGuid = c.req.param('guid')

    const feed = await ServerFeed.get(c.env.DB, feedGuid)

    return feed ? c.json(new ClientFeed(feed), 200) : apiError(c, 404, `No feed found with guid: ${feedGuid}`)
})
app.patch('/feed/:guid', async (c) => {
    const data = await c.req.json() as Record<string, unknown>
    const feedGuid = c.req.param('guid')
    const db = c.env.DB

    for (const key of Object.keys(data)) {
        if (!['categories', 'alias', 'notify_enabled'].includes(key)) {
            return apiError(c, 422, `Cannot update the feed field: ${key}`)
        }
    }

    const updateData: Record<string, unknown> = {}
    if ('categories' in data) {
        const categories = data.categories as string[]
        if (categories.some(c => c.includes(','))) {
            return apiError(c, 422, 'Category names cannot contain commas')
        }
        updateData.categories = categories.join(',')
    }
    if ('alias' in data) {
        updateData.alias = typeof data.alias === 'string' ? data.alias : ''
    }
    if ('notify_enabled' in data) {
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
app.get('/feed/:guid/feeditem', async (c) => {
    const feedGuid = c.req.param('guid')
    const {
        include_finished,
        sort_order,
        limit = 20,
        offset = 0,
    } = c.req.query()

    const {results} = await c.env.DB
        .prepare(`
            SELECT * FROM feed_item 
            WHERE source_feed = ? ${include_finished === 'true' ? '' : 'AND finished = FALSE'} 
            ORDER BY date ${sort_order === 'desc' ? 'DESC' : 'ASC'} 
            LIMIT ? OFFSET ?`)
        .bind(feedGuid, limit, offset)
        .all<RawFeedItem>()

    return c.json(results.map(item => new ClientFeedItem(new ServerFeedItem(item))), 200)
})

/******************************************************************************
 * Feed item endpoints
 *****************************************************************************/

app.get('/feeditem', async (c) => {
    const db = c.env.DB;
    const bookmarked = c.req.query('bookmarked')
    const limit = parseInt(c.req.query('limit') ?? '20')
    const offset = parseInt(c.req.query('offset') ?? '0')

    let feedItems
    if (bookmarked === 'true') {
        feedItems = await getBookmarkedFeedItems(db)
    } else {
        feedItems = await getFeedItems(db, {limit, offset})
    }

    return c.json(feedItems.map(item => new ClientFeedItem(item)), 200)
})

app.get('/feeditem/:guid', async (c) => {
    const guid = c.req.param('guid')

    const feedItem = await ServerFeedItem.get(c.env.DB, guid)

    return feedItem ? c.json(new ClientFeedItem(feedItem), 200) : apiError(c, 404, `No feed item found with guid: ${guid}`)
})
app.get('/feeditem/:guid/media', async (c) => {
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
app.get('/feeditem/:guid/transcript', async (c) => {
    const guid = c.req.param('guid')
    const transcripts = await listTranscriptsForItem(c.env.DB, guid)
    return c.json(transcripts.map(t => new ClientTranscript(t)), 200)
})
app.post('/feeditem/:guid/transcript', async (c) => {
    const guid = c.req.param('guid')
    const body = await c.req.json().catch(() => ({})) as {model?: string, language?: string}

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
app.get('/transcript/:id', async (c) => {
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
app.get('/feeditem/:guid/adjacent', async (c) => {
    const guid = c.req.param('guid')
    const {prev, next} = await getAdjacentFeedItems(c.env.DB, guid)
    return c.json({
        prev: prev ? new ClientFeedItemPreview(prev) : null,
        next: next ? new ClientFeedItemPreview(next) : null,
    }, 200)
})

app.patch('/feeditem/:guid', async (c) => {
    const data = await c.req.json() as Record<string, unknown>
    const feedItemGuid = c.req.param('guid')
    const db = c.env.DB

    for (const key of Object.keys(data)) {
        if (!['finished', 'progress', 'bookmarked'].includes(key)) {
            return apiError(c, 422, `Cannot update the feed item field: ${key}`)
        }
    }

    await db
        .prepare(`
            UPDATE feed_item 
            SET ${Object.keys(data).map(key => `${key} = ?`).join(', ')}
            WHERE guid = ?`)
        .bind(...Object.values(data), feedItemGuid)
        .run()

    return c.body(null, 200)
})

/******************************************************************************
 * Feed item endpoints
 *****************************************************************************/

async function hydrateQueueItems(db: D1Database, guids: string[]) {
    const items = await Promise.all(guids.map(guid => ServerFeedItem.get(db, guid)))
    return items
        .filter((item): item is ServerFeedItem => item !== null)
        .map(item => new ClientFeedItemPreview(item))
}

app.get('/queue', async (c) => {
    const queue = getQueue(c.env)
    const guids = await queue.getItems()
    return c.json({items: await hydrateQueueItems(c.env.DB, guids)}, 200)
})

app.post('/queue', async (c) => {
    const db = c.env.DB
    const data = await c.req.json() as {feedItemId?: string, position?: unknown}
    const {feedItemId, position} = data

    if (!feedItemId) {
        return apiError(c, 400, 'feedItemId is required')
    }

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

app.patch('/queue/:guid', async (c) => {
    const feedItemGuid = c.req.param('guid')
    const {position} = await c.req.json() as {position?: unknown}

    if (typeof position !== 'number') {
        return apiError(c, 400, 'position is required')
    }

    const queue = getQueue(c.env)
    const guids = await queue.insertItem(feedItemGuid, position)

    return c.json({items: await hydrateQueueItems(c.env.DB, guids)}, 200)
})

app.delete('/queue/:guid', async (c) => {
    const feedItemGuid = c.req.param('guid')
    const queue = getQueue(c.env)
    const guids = await queue.removeItem(feedItemGuid)

    return c.json({items: await hydrateQueueItems(c.env.DB, guids)}, 200)
})

app.delete('/queue', async (c) => {
    const keepFirst = c.req.query('keepFirst') === 'true'
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

app.post('/command/refresh-feed/:guid', async (c) => {
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

app.post('/command/plan-feed-archives/:guid', async (c) => {
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

app.post('/command/refresh-all-feeds', async (c) => {
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

app.get('/notification', async (c) => {
    const db = c.env.DB
    const includeDismissed = c.req.query('include_dismissed') === 'true'
    const requested = parseInt(c.req.query('limit') ?? '50')
    const limit = Math.max(1, Math.min(200, Number.isFinite(requested) ? requested : 50))

    const [items, unreadCount] = await Promise.all([
        getNotifications(db, {limit, includeDismissed}),
        getUnreadNotificationCount(db),
    ])

    return c.json({items, unreadCount}, 200)
})

app.delete('/notification/:id', async (c) => {
    const id = parseInt(c.req.param('id'))
    if (!Number.isFinite(id)) {
        return apiError(c, 400, 'Invalid notification id')
    }
    await dismissNotification(c.env.DB, id)
    return c.body(null, 200)
})

app.delete('/notification', async (c) => {
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

app.get('/push/vapid-public-key', (c) => {
    const env = c.env as unknown as {VAPID_PUBLIC_KEY?: string}
    const key = env.VAPID_PUBLIC_KEY ?? ''
    if (!key) {
        return apiError(c, 503, 'Push notifications not configured')
    }
    return c.json({key}, 200)
})

app.post('/push/subscription', async (c) => {
    const data = await c.req.json().catch(() => null) as {endpoint?: string, keys?: {p256dh?: string, auth?: string}} | null
    const endpoint = data?.endpoint
    const keys = data?.keys
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return apiError(c, 400, 'endpoint, keys.p256dh, and keys.auth are required')
    }
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

app.delete('/push/subscription', async (c) => {
    const data = await c.req.json().catch(() => ({})) as {endpoint?: string}
    const endpoint = data.endpoint ?? c.req.query('endpoint')
    if (!endpoint) {
        return apiError(c, 400, 'endpoint is required')
    }
    await deletePushSubscription(c.env.DB, endpoint)
    return c.body(null, 200)
})

app.post('/push/test', async (c) => {
    const data = await c.req.json().catch(() => null) as {endpoint?: string} | null

    const context = await loadPushFanOutContext(c.env)
    if (!context) {
        return apiError(c, 503, 'Push not configured or no subscribers')
    }

    const subscriptions = data?.endpoint
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
