import {ClientFeedItem} from "../../models";
import {getFeedItem} from "../../manage";

interface PathParams {
    guid: string
}

export async function onRequestGet(context) {
    const feedItemGuid = context.params.guid;

    const feedItem = await getFeedItem(context.env.DB, feedItemGuid)

    // TODO check if no feed item exists

    return Response.json(new ClientFeedItem(feedItem))
}
