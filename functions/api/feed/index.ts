import type {Env} from '../../types';
import type {EventContext, Response} from '@cloudflare/workers-types';
import {ClientFeed, ServerFeedSource} from "../../models.ts";
import {
    createFeed, createFeedFile, createFeedItem,
    createFeedSource,
    getFeed,
    getFeedFile,
    getFeeds,
    getFeedSources
} from "../../manage";
import {fetchRss} from "../../client";
import {parseRssText, sha256Encode} from "../../utils/files";

export async function onRequestGet(context: EventContext<Env, any, any>) {
    const feeds = await getFeeds(context.env.DB)

    return Response.json(feeds.map(feed => new ClientFeed(feed)))
}

/**
 * Submit a new feed url to generate a feed.
 * @param context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context: EventContext<Env, any, any>) {
    const db = context.env.DB;
    const cache_bucket = context.env.RSS_CACHE_BUCKET;
    const requestData = await context.request.json()
    const inputUrl = requestData.url;

    // fetch data
    const fetchResult = await fetchRss(inputUrl)
    if (fetchResult.status === 'failure') {
        return new Response(null, {status: 400})
    }

    const {channel, items} = parseRssText(fetchResult.text)

    // identify feed (if already exists, or create a new feed)
    const feed = await getFeed(db, channel.guid)
        ?? await createFeed(db, channel, fetchResult)

    // identify feed source (if already exists, or create a new feed source)
    const feedSources = await getFeedSources(db, feed)
    const feedSource = feedSources.find(source => source.feed_url === fetchResult.requestUrl) as ServerFeedSource
        ?? await createFeedSource(db, feed, channel, fetchResult)

    // identify feed file (if already exists, or create a new feed file record)
    const contentHash = await sha256Encode(fetchResult.text)
    const feedFile = await getFeedFile(db, contentHash)
        ?? await createFeedFile(db, cache_bucket, feedSource, fetchResult)

    // go back and update "statistics" fields
    // TODO

    await Promise.all([
        feed.persistTo(db),
        feedSource.persistTo(db),
        feedFile.persistTo(db, cache_bucket),
    ])

    // merge feed items
    await Promise.all(items.map(async item => {
        const feedItem = await createFeedItem(db, feed, item)
        await feedItem.persistTo(db)
    }))

    // if new feed, generate tasks to pull archived files


    return new Response()
}
