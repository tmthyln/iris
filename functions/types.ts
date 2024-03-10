import type {D1Database, R2Bucket, Queue} from '@cloudflare/workers-types'

export interface Env {
    DB: D1Database
    RSS_CACHE_BUCKET: R2Bucket
    FEED_PROCESSING_QUEUE: Queue
}

export interface FeedProcessingTask {

}

interface FetchResult {
    timestamp: string
    inputUrl: string
}

export interface SuccessfulFetchResult extends FetchResult {
    status: 'success'
    requestUrl: string
    text: string
}

export interface FailedFetchResult extends FetchResult {
    status: 'failure'
}
