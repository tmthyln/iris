import type {D1Database} from '@cloudflare/workers-types';
import { Hono } from 'hono';
import {
    ClientFeed,
    ClientFeedItemPreview,
    ServerFeed,
    ServerFeedSource,
    ClientFeedItem,
    ServerFeedItem,
    ServerFeedFile,
    RawFeedItem
} from './models'
import {
    createFeed,
    createFeedItem,
    createFeedSource,
    getFeeds,
    getBookmarkedFeedItems,
    getFeedItems,
    createFeedFile
} from './crud'
import type { RefreshFeedTask, PlanFeedArchivesTask } from "./types";
import {fetchRssFile, parseRssText} from "./utils/files";
import {getQueue} from "./queue";
import {refreshFeed} from "./flows";

export const app = new Hono<{Bindings: Env}>().basePath('/api');

/******************************************************************************
 * Feed endpoints
 *****************************************************************************/

app.get('/feed', async (c) => {
    const feeds = await getFeeds(c.env.DB)

    return Response.json(feeds.map(feed => new ClientFeed(feed)))
})
app.post('/feed', async (c) => {
    const db = c.env.DB;
    const cache_bucket = c.env.RSS_CACHE_BUCKET;
    const queue = c.env.FEED_PROCESSING_QUEUE;
    const requestData = await c.req.json()
    const inputUrl = requestData.url;

    // fetch live content from input url
    const fetchResult = await fetchRssFile(inputUrl)
    if (fetchResult.status === 'error') {
        const messages: Record<string, string> = {
            'blocked-by-bot-protection': 'URL is protected by bot detection. Try providing the direct RSS feed URL instead.',
            'no-rss-link-found': 'No RSS feed found at the provided URL.',
        }
        const message = messages[fetchResult.reason] ?? 'Provided URL was not accessible.'
        return new Response(JSON.stringify({error: message}), {
            status: 502,
            headers: {'Content-Type': 'application/json'},
        })
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

        return new Response(null, {status: 202, statusText: 'Feed already exists, refreshing feed...'})
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
    await Promise.all(items.map(async item =>
        await createFeedItem(feed, item).persistTo(db)
    ))

    await queue.send({
        type: 'plan-feed-archives',
        feedGuid: feed.guid,
    } satisfies PlanFeedArchivesTask)

    return new Response(null, {status: 200, statusText: 'Feed loaded.'})
})
app.get('/feed/:guid', async (c) => {
    const feedGuid = c.req.param('guid')

    const feedItem = await ServerFeed.get(c.env.DB, feedGuid)

    return feedItem ? Response.json(new ClientFeed(feedItem)) : new Response(null, {status: 404, statusText: `No feed found with guid: ${feedGuid}`})
})
app.patch('/feed/:guid', async (c) => {
    const data = await c.req.json()
    const feedGuid = c.req.param('guid')
    const db = c.env.DB

    for (const key of Object.keys(data)) {
        if (!['categories'].includes(key)) {
            return Response.json(null, {status: 422, statusText: `Cannot update the feed field: ${key}`})
        }
    }

    const updateData: Record<string, unknown> = {}
    if ('categories' in data) {
        const categories = data.categories as string[]
        if (categories.some(c => c.includes(','))) {
            return Response.json(null, {status: 422, statusText: 'Category names cannot contain commas'})
        }
        updateData.categories = categories.join(',')
    }

    await db
        .prepare(`
            UPDATE feed
            SET ${Object.keys(updateData).map(key => `${key} = ?`).join(', ')}
            WHERE guid = ?`)
        .bind(...Object.values(updateData), feedGuid)
        .run()

    return new Response()
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

    return Response.json(results.map(item => new ClientFeedItem(new ServerFeedItem(item))))
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

    return Response.json(feedItems.map(item => new ClientFeedItem(item)))
})

app.get('/feeditem/:guid', async (c) => {
    const guid = c.req.param('guid')

    const feedItem = await ServerFeedItem.get(c.env.DB, guid)

    return feedItem ? Response.json(new ClientFeedItem(feedItem)) : new Response(null, {status: 404, statusText: `No feed item found with guid: ${guid}`})
})
app.patch('/feeditem/:guid', async (c) => {
    const data = await c.req.json()
    const feedItemGuid = c.req.param('guid')
    const db = c.env.DB

    for (const key of Object.keys(data)) {
        if (!['finished', 'progress', 'bookmarked'].includes(key)) {
            return Response.json(null, {status: 422, statusText: `Cannot update the feed item field: ${key}`})
        }
    }

    await db
        .prepare(`
            UPDATE feed_item 
            SET ${Object.keys(data).map(key => `${key} = ?`).join(', ')}
            WHERE guid = ?`)
        .bind(...Object.values(data), feedItemGuid)
        .run()

    return new Response()
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
    return Response.json({items: await hydrateQueueItems(c.env.DB, guids)})
})

app.post('/queue', async (c) => {
    const db = c.env.DB
    const data = await c.req.json()
    const {feedItemId, position} = data

    if (!feedItemId) {
        return new Response(null, {status: 400, statusText: 'feedItemId is required'})
    }

    const feedItem = await ServerFeedItem.get(db, feedItemId)
    if (!feedItem) {
        return new Response(null, {status: 404, statusText: `No feed item found with id: ${feedItemId}`})
    }

    const feed = await ServerFeed.get(db, feedItem.source_feed)
    if (feed?.type !== 'podcast') {
        return new Response(null, {status: 400, statusText: 'Only podcast feed items can be queued'})
    }

    const queue = getQueue(c.env)
    let guids
    if (typeof position === 'number') {
        guids = await queue.insertItem(feedItemId, position)
    } else {
        guids = await queue.enqueueItem(feedItemId)
    }

    return Response.json({items: await hydrateQueueItems(db, guids)}, {status: 201})
})

app.patch('/queue/:guid', async (c) => {
    const feedItemGuid = c.req.param('guid')
    const {position} = await c.req.json()

    if (typeof position !== 'number') {
        return new Response(null, {status: 400, statusText: 'position is required'})
    }

    const queue = getQueue(c.env)
    const guids = await queue.insertItem(feedItemGuid, position)

    return Response.json({items: await hydrateQueueItems(c.env.DB, guids)})
})

app.delete('/queue/:guid', async (c) => {
    const feedItemGuid = c.req.param('guid')
    const queue = getQueue(c.env)
    const guids = await queue.removeItem(feedItemGuid)

    return Response.json({items: await hydrateQueueItems(c.env.DB, guids)})
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

    return Response.json({items: await hydrateQueueItems(c.env.DB, guids)})
})

/******************************************************************************
 * Command endpoints
 *****************************************************************************/

app.post('/command/refresh-all-feeds', async (c) => {
    const feeds = await getFeeds(c.env.DB)

    for (const feed of feeds) {
        await refreshFeed(feed.guid, c.env)
    }
    //await Promise.all(feeds.map(feed => refreshFeed(feed.guid, c.env)))

    return Response.json({refreshedCount: feeds.length})
})
