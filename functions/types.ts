import type {D1Database, R2Bucket} from '@cloudflare/workers-types'

export interface Env {
    DB: D1Database,
    RSS_CACHE_BUCKET: R2Bucket,
}
