import {ServerFeed, ServerFeedFile} from "./models";
import {createFeedFile, createFeedItem, getUpdatableFeedSources} from "./crud";
import {fetchRssFile, parseRssText} from "./utils/files";

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
        await Promise.all(items.map(async item =>
            await createFeedItem(feed, item).persistTo(db)
        ))
    }
}