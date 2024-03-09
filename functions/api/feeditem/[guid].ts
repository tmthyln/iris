import {ClientFeedItem, ServerFeedItem} from "../../models";

interface PathParams {
    guid: string
}

export async function onRequestGet(context) {
    const feedItemGuid = context.params.guid;

    const feedItem = await context.env.DB
        .prepare(`SELECT * FROM feed_item WHERE guid = ?`)
        .bind(feedItemGuid)
        .first()

    // TODO check if no feed item exists

    return Response.json(new ClientFeedItem(new ServerFeedItem(feedItem)))
}
