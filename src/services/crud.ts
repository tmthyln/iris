import type {D1Database} from "@cloudflare/workers-types";
import {RawFeed, RawFeedItem, RawFeedSource, ServerFeed, ServerFeedFile, ServerFeedItem, ServerFeedSource} from "./models";
import {ChannelData, ChannelItemData, sha256Encode} from "./utils/files";
import {FetchSuccessFileResult} from "./types";

/******************************************************************************
 * Read-only queries
 *****************************************************************************/

export async function getFeeds(db: D1Database) {
    const { results } = await db
        .prepare(`
            SELECT * FROM feed 
            WHERE active = TRUE 
            ORDER BY last_updated DESC`)
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

export function createFeed(channelData: ChannelData, fetchResult: FetchSuccessFileResult) {
    return new ServerFeed({
        guid: channelData.guid,
        input_url: fetchResult.metadata.inputUrl,
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

export function createFeedItem(feed: ServerFeed, channelItemData: ChannelItemData) {
    return new ServerFeedItem({
        ...channelItemData,
        source_feed: feed.guid,
        finished: false,
        progress: 0,
    })
}

export async function addItemToQueue(
    db: D1Database,
    feedItemOrId: ServerFeedItem | string,
    order: 'start' | 'end' | number,
) {
    const feedItemId = typeof feedItemOrId === 'string' ? feedItemOrId : feedItemOrId.guid;

    if (order === 'end') {
        await db
            .prepare(`
                INSERT INTO queue_item(feed_item_guid, queue_order)
                SELECT ?, COALESCE(MAX(queue_order), -1) + 1
                FROM queue_item`)
            .bind(feedItemId)
            .run()
    } else {
        const queueOrder = order === 'start' ? 0 : order
        await db.batch([
            db
                .prepare(`
                    UPDATE queue_item
                    SET queue_order = queue_order + 1
                    WHERE queue_order >= ?`)
                .bind(queueOrder),
            db
                .prepare(`
                    INSERT INTO queue_item(queue_order, feed_item_guid)
                    VALUES (?, ?)
                    ON CONFLICT(feed_item_guid) DO UPDATE SET queue_order = queue_order`)
                .bind(queueOrder, feedItemId),
        ])
    }
}
