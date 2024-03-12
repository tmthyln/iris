import {ClientFeedItem} from "../../models";
import {getFeedItems} from "../../manage";

export async function onRequestGet(context) {
    const url = new URL(context.request.url)
    const searchParams = url.searchParams

    const feedItems = await getFeedItems(context.env.DB, {
        limit: parseInt(searchParams.get('limit') ?? '20'),
    })

    return Response.json(feedItems.map(item => new ClientFeedItem(item)))
}
