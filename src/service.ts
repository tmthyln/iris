import { app } from './services/endpoints'
import {FeedProcessingTask, RefreshFeedTask} from "./services/types";
import {refreshFeed, planFeedArchives, fetchArchiveSnapshot} from "./services/flows";
import {getFeeds} from "./services/crud";
export {ItemQueue} from "./services/queue";

// noinspection JSUnusedGlobalSymbols
export default {
    fetch: app.fetch,

    async queue(batch, env, _ctx): Promise<void> {
        for (const msg of batch.messages) {
            const task = msg.body as FeedProcessingTask

            switch(task.type) {
                case 'refresh-feed':
                    console.log('Received request to refresh feed')
                    await refreshFeed(task.feedGuid, env)
                    break
                case 'plan-feed-archives':
                    console.log('Received request to plan archives for feed')
                    await planFeedArchives(task.feedGuid, env)
                    break
                case 'fetch-archive-snapshot':
                    console.log('Received request to fetch archive snapshot')
                    await fetchArchiveSnapshot(task, env)
                    break
            }

            msg.ack()
        }
    },

    async scheduled(event, env, _ctx) {
        console.log('Kicking off scheduled refresh of all active feeds')

        const feeds = await getFeeds(env.DB)
        for (const feed of feeds) {
            // TODO selectively refresh feeds based on update frequency
            await env.FEED_PROCESSING_QUEUE.send({
                type: 'refresh-feed',
                feedGuid: feed.guid,
            } as RefreshFeedTask)
        }
    },
} satisfies ExportedHandler<Env>;
