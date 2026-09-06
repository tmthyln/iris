import {fetchArchiveSnapshot, planFeedArchives, refreshFeed, transcribeFeedItem} from './flows'
import type {FeedProcessingTask} from './types'

/** Cloudflare accepts at most this many messages in one sendBatch() call. */
const SEND_BATCH_LIMIT = 100

const RETRY_BASE_DELAY_SEC = 60
const RETRY_MAX_DELAY_SEC = 15 * 60

/**
 * Runs one feed-processing task. Every queue message is dispatched through
 * here; a Preview, which has no queue consumer, could run tasks inline the
 * same way (#247). Failures a flow doesn't handle itself propagate to the
 * caller, which decides whether to retry.
 */
export async function runTask(task: FeedProcessingTask, env: Env, ctx?: ExecutionContext): Promise<void> {
    switch (task.type) {
        case 'refresh-feed':
            await refreshFeed(task.feedGuid, env, ctx)
            return
        case 'plan-feed-archives':
            await planFeedArchives(task.feedGuid, env)
            return
        case 'fetch-archive-snapshot':
            await fetchArchiveSnapshot(task, env)
            return
        case 'transcribe-feed-item':
            await transcribeFeedItem(task.transcriptId, env)
            return
        default:
            // Enqueued by a different deployment; retrying would not help.
            console.warn(`Ignoring queue task of unknown type: ${String((task as {type?: unknown}).type)}`)
    }
}

/** Enqueues tasks in chunks that fit one sendBatch() call; a no-op for none. */
export async function enqueueTasks(queue: Queue, tasks: readonly FeedProcessingTask[]): Promise<void> {
    for (let start = 0; start < tasks.length; start += SEND_BATCH_LIMIT) {
        const chunk = tasks.slice(start, start + SEND_BATCH_LIMIT)
        await queue.sendBatch(chunk.map(body => ({body})))
    }
}

/**
 * Delay before redelivering a message that failed on its `attempts`-th
 * delivery: one minute, doubling each time, capped at fifteen minutes.
 */
export function retryDelaySeconds(attempts: number): number {
    const exponent = Math.max(0, attempts - 1)
    return Math.min(RETRY_BASE_DELAY_SEC * 2 ** exponent, RETRY_MAX_DELAY_SEC)
}
