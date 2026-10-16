import {app} from './services/endpoints'
import {getFeeds} from './services/crud'
import {enqueueTasks, retryDelaySeconds, runTask} from './services/tasks'
import type {FeedProcessingTask, RefreshFeedTask} from './services/types'
import {log, withLogContext} from './services/utils/log'
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
            // The task's trace keeps the ids of the request that enqueued it.
            await withLogContext({
                ...task.trace,
                taskType: task.type,
                messageId: msg.id,
                attempt: msg.attempts,
            }, async () => {
                try {
                    log.info('Processing task', {task})
                    await runTask(task, env, ctx)
                    msg.ack()
                } catch (err) {
                    const delaySeconds = retryDelaySeconds(msg.attempts)
                    log.error('Task failed; retrying', {delaySeconds, error: err})
                    msg.retry({delaySeconds})
                }
            })
        }
    },

    async scheduled(event, env, _ctx) {
        // The cron run gets its own requestId, which its tasks carry along.
        await withLogContext({requestId: crypto.randomUUID(), trigger: 'cron', cron: event.cron}, async () => {
            const feeds = await getFeeds(env.DB)
            log.info('Enqueuing a refresh for every active feed', {feedCount: feeds.length})
            // TODO selectively refresh feeds based on update frequency
            await enqueueTasks(env.FEED_PROCESSING_QUEUE, feeds.map((feed): RefreshFeedTask => ({
                type: 'refresh-feed',
                feedGuid: feed.guid,
            })))
        })
    },
} satisfies ExportedHandler<Env>
