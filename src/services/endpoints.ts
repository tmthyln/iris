import { Hono } from 'hono';
import {
    ClientFeed,
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
import type { RefreshFeedTask, LoadFeedSourceArchivesTask } from "./types";
import {fetchRssFile, parseRssText} from "./utils/files";

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
    const {content, status, metadata} = fetchResult
    if (status === 'error') {
        return new Response(null, {status: 502, statusText: 'Provided URL was not accessible.'})
    }

    // look up feed source by URL,
    const existingFeedSource = await ServerFeedSource.get(db, metadata.requestUrl)
    if (existingFeedSource) {
        await queue.send({
            type: 'refresh-feed',
            feedGuid: existingFeedSource.referenced_feed,
        } satisfies RefreshFeedTask)

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

        queue.send({
            type: 'load-feed-source-archives',
            feedSourceUrl: metadata.requestUrl,
        } satisfies LoadFeedSourceArchivesTask)
    }

    // resolve feed
    const feed = await ServerFeed.get(db, channel.guid)
        ?? await createFeed(channel, fetchResult).persistTo(db)

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
        type: 'load-feed-source-archives',
        feedSourceUrl: feedSource.feed_url,
    } satisfies LoadFeedSourceArchivesTask)

    return new Response(null, {status: 200, statusText: 'Feed loaded.'})
})
app.get('/feed/:guid', async (c) => {
    const feedGuid = c.req.param('guid')

    const feedItem = await ServerFeed.get(c.env.DB, feedGuid)

    return feedItem ? Response.json(new ClientFeed(feedItem)) : new Response(null, {status: 404, statusText: `No feed found with guid: ${feedGuid}`})
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

    let feedItems = []
    if (bookmarked === 'true') {
        feedItems = await getBookmarkedFeedItems(db)
    } else {
        feedItems = await getFeedItems(db, {limit})
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
