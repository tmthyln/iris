import {ClientFeedItem} from "../../models";
import {getFeedItems} from "../../manage";

export async function onRequestGet(context) {
    const feedItems = await getFeedItems(context.env.DB)

    return Response.json(feedItems.map(item => new ClientFeedItem(item)))
}
