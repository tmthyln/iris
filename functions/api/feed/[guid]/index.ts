import {ClientFeed, ServerFeed} from "../../../models";

export async function onRequestGet(context) {
    const feedGuid = context.params.guid;

    const feedItem = await context.env.DB
        .prepare(`SELECT * FROM feed WHERE guid = ?`)
        .bind(feedGuid)
        .first()

    // TODO check if no feed exists

    return Response.json(new ClientFeed(new ServerFeed(feedItem)))
}
