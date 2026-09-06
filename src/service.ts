import {app} from './services/endpoints'
import {getFeeds} from './services/crud'
import {enqueueTasks, retryDelaySeconds, runTask} from './services/tasks'
import type {FeedProcessingTask, RefreshFeedTask} from './services/types'
export {ItemQueue} from './services/queue'

// noinspection JSUnusedGlobalSymbols
export default {
    fetch: app.fetch,

    // Messages are processed one at a time and each is acknowledged or retried
    // on its own, so a failing task neither aborts the rest of its batch nor
    // gets the whole batch redelivered. Retries back off exponentially; after
    // max_retries (wrangler.toml) the message lands on the dead-letter queue.
    async queue(batch, env, ctx): Promise<void> {
        for (const msg of batch.messages) {
            const task = msg.body as FeedProcessingTask
            try {
                console.log(`Processing ${task.type} task (message ${msg.id}, attempt ${msg.attempts})`)
                await runTask(task, env, ctx)
                msg.ack()
            } catch (err) {
                const delaySeconds = retryDelaySeconds(msg.attempts)
                console.error(`Task ${task.type} failed on attempt ${msg.attempts}; retrying in ${delaySeconds}s`, err)
                msg.retry({delaySeconds})
            }
        }
    },

    async scheduled(_event, env, _ctx) {
        const feeds = await getFeeds(env.DB)
        console.log(`Enqueuing a refresh for ${feeds.length} active feeds`)
        // TODO selectively refresh feeds based on update frequency
        await enqueueTasks(env.FEED_PROCESSING_QUEUE, feeds.map((feed): RefreshFeedTask => ({
            type: 'refresh-feed',
            feedGuid: feed.guid,
        })))
    },
} satisfies ExportedHandler<Env>
