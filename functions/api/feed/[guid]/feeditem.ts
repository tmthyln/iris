import {ClientFeedItem, ServerFeedItem} from "../../../models";

export async function onRequestGet(context) {
    const feedGuid = decodeURIComponent(context.params.guid);
    const searchParams = new URL(context.request.url).searchParams

    const {results} = await context.env.DB
        .prepare(`
            SELECT * FROM feed_item 
            WHERE source_feed = ? ${searchParams.get('include_finished') === 'true' ? '' : 'AND finished = FALSE'} 
            ORDER BY date ${searchParams.get('sort_order') === 'desc' ? 'DESC' : 'ASC'} 
            LIMIT ? OFFSET ?`)
        .bind(feedGuid, searchParams.get('limit') ?? 20, searchParams.get('offset') ?? 0)
        .all()

    return Response.json(results.map(item => new ClientFeedItem(new ServerFeedItem(item))))
}