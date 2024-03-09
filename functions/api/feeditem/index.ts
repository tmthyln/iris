import {ClientFeedItem, ServerFeedItem} from "../../models";

export async function onRequestGet(context) {
    const {results} = await context.env.DB
        .prepare(`
            SELECT feed_item.* FROM feed_item
            JOIN feed ON feed_item.source_feed = feed.guid
            WHERE feed.active = TRUE
            ORDER BY feed_item.date DESC`)
        .all()

    return Response.json(results.map(item => new ClientFeedItem(new ServerFeedItem(results))))
}
