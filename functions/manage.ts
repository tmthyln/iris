import type {D1Database, R2Bucket} from "@cloudflare/workers-types";
import {ServerFeed, ServerFeedFile, ServerFeedItem, ServerFeedSource} from "./models";
import {ChannelData, ChannelItemData, sha256Encode} from "./utils/files";
import {SuccessfulFetchResult} from "./types";

/******************************************************************************
 * Read-only queries
 *****************************************************************************/

export async function getFeed(db: D1Database, guid: string) {
    const rawFeed = await db.prepare('SELECT * FROM feed WHERE guid = ?')
        .bind(guid)
        .first()

    return rawFeed !== null ? new ServerFeed(rawFeed, 'persisted') : null
}

export async function getFeedItem(db: D1Database, guid: string) {
    const rawFeedItem = await db
        .prepare('SELECT * FROM feed_item WHERE guid = ?')
        .bind(guid)
        .first()

    return rawFeedItem !== null ? new ServerFeedItem(rawFeedItem, 'persisted') : null
}

export async function getFeedSources(db: D1Database, feed: ServerFeed) {
    const {results} = await db
        .prepare(`
            SELECT feed_source.* FROM feed_source 
            LEFT JOIN feed ON feed_source.referenced_feed = feed.guid
            WHERE feed.guid = ?`)
        .bind(feed.guid)
        .all()

    return results.map(item => new ServerFeedSource(item, 'persisted'))
}

export async function getFeedFile(db: D1Database, feedUrl: string, fetchedAt: Date): Promise<ServerFeedFile>;
export async function getFeedFile(db: D1Database, contentHash: string): Promise<ServerFeedFile>;
export async function getFeedFile(db: D1Database, feedUrlOrContentHash: string, fetchedAt?: Date){
    let rawFeedFile;
    if (fetchedAt === undefined) {
        rawFeedFile = await db
            .prepare('SELECT * FROM feed_file WHERE sha256_hash = ?')
            .bind(feedUrlOrContentHash)
            .first()
    } else {
        rawFeedFile = await db
            .prepare('SELECT * FROM feed_file WHERE feed_url = ? AND datetime(fetched_at) = datetime(?)')
            .bind(feedUrlOrContentHash, fetchedAt.toISOString())
            .first()
    }

    return rawFeedFile !== null ? new ServerFeedFile(rawFeedFile, null, 'persisted') : null
}

export async function getFeeds(db: D1Database) {
    const { results } = await db
        .prepare(`
            SELECT * FROM feed 
            WHERE active = TRUE 
            ORDER BY last_updated DESC`)
        .all()

    return results.map(item => new ServerFeed(item, 'persisted'))
}

export async function getFeedItems(db: D1Database) {
    const {results} = await db
        .prepare(`
            SELECT feed_item.* FROM feed_item
            JOIN feed ON feed_item.source_feed = feed.guid
            WHERE feed.active = TRUE
            ORDER BY feed_item.date DESC
            LIMIT 20`)
        .all()

    return results.map(item => new ServerFeedItem(item, 'persisted'))
}

/******************************************************************************
 * CUD (modifying queries)
 *****************************************************************************/

export function createFeed(db: D1Database, channelData: ChannelData, fetchResult: SuccessfulFetchResult) {
    return new ServerFeed({
        guid: channelData.guid,
        input_url: fetchResult.inputUrl,
        source_url: channelData.source_url,
        title: channelData.title,
        alias: '',
        description: channelData.description,
        author: channelData.author,
        type: channelData.type,
        ongoing: true,
        active: true,
        image_src: channelData.image_src,
        image_alt: channelData.image_alt,
        last_updated: channelData.last_updated,
        update_frequency: 1,
        link: channelData.link,
        categories: channelData.categories,
    }, 'new')
}

export function createFeedSource(db: D1Database, feed: ServerFeed, channelData: ChannelData, fetchResult: SuccessfulFetchResult) {
    return new ServerFeedSource({
        feed_url: fetchResult.requestUrl,
        referenced_feed: feed.guid,
        actively_updating: true,
        last_updated: channelData.last_updated,
        last_fetched: fetchResult.timestamp,
        archive: false,
        primary_source: false,

    })
}

export async function createFeedFile(
    db: D1Database, bucket: R2Bucket,
    feedSource: ServerFeedSource, fetchResult: SuccessfulFetchResult,
) {
    const filename = `cached-file-${await sha256Encode(fetchResult.requestUrl)}-${new Date(fetchResult.timestamp).getTime()}.rss`
    const contentHash = await sha256Encode(fetchResult.text)

    return new ServerFeedFile({
        feed_url: feedSource.feed_url,
        fetched_at: fetchResult.timestamp,
        referenced_feed: feedSource.referenced_feed,
        cached_file: filename,
        sha256_hash: contentHash,
    })
}

export async function createFeedItem(
    db: D1Database,
    feed: ServerFeed, channelItemData: ChannelItemData,
){
    return new ServerFeedItem({
        ...channelItemData,
        source_feed: feed.guid,
        finished: false,
        progress: 0,
    })
}
