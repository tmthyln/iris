import {ClientFeedItem, ServerFeedItem} from "../../../models";

export async function onRequestGet(context) {
    const feedGuid = decodeURIComponent(context.params.guid);

    const {results} = await context.env.DB
        .prepare(`SELECT * FROM feed_item WHERE source_feed = ? ORDER BY date DESC LIMIT 20`)
        .bind(feedGuid)
        .all()

    return Response.json(results.map(item => new ClientFeedItem(new ServerFeedItem(item))))
}