import {ClientFeed} from "../../../models";
import {getFeed} from "../../../manage";

export async function onRequestGet(context) {
    const feedGuid = decodeURIComponent(context.params.guid)

    const feedItem = await getFeed(context.env.DB, feedGuid)

    // TODO check if no feed exists

    return Response.json(new ClientFeed(feedItem))
}
