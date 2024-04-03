import {ClientFeedItem} from "../../models";
import {getFeedItems, getBookmarkedFeedItems} from "../../manage";

export async function onRequestGet(context) {
    const db = context.env.DB;
    const url = new URL(context.request.url)
    const searchParams = url.searchParams

    let feedItems = []
    if (searchParams.has('bookmarked', 'true')) {
        feedItems = await getBookmarkedFeedItems(db)
    } else {
        feedItems = await getFeedItems(db, {
            limit: parseInt(searchParams.get('limit') ?? '20'),
        })
    }

    return Response.json(feedItems.map(item => new ClientFeedItem(item)))
}
