import type {hc, InferRequestType, InferResponseType} from 'hono/client'
// Type-only import: erased at build time, so no Worker code reaches the browser bundle.
// tsconfig.app.json references tsconfig.cf.json to resolve it.
import type {AppType} from './services/endpoints'

export type LoadingState = 'unloaded' | 'loading' | 'loaded'

// Result of an API call. On failure, status is null when the request never
// completed (offline/timeout), or the HTTP status when the server rejected it.
export type ApiResult<T> =
    | {ok: true, status: number, data: T}
    | {ok: false, status: number | null, error: string}

/******************************************************************************
 * API types, derived from the Worker's route schema (Hono RPC).
 *
 * The shapes below are whatever the endpoints in src/services/endpoints.ts
 * respond with — after JSON serialisation, so `Date` fields are strings —
 * and the inputs their validators accept. Changing a Client* model or a
 * validator on the server changes these types, and the frontend fails to
 * typecheck if it disagrees.
 *****************************************************************************/

/** The typed RPC client shape; src/client.ts instantiates it. */
export type Rpc = ReturnType<typeof hc<AppType>>

type Json<T> = InferResponseType<T, 200>

export type Feed = Json<Rpc['api']['feed']['$get']>[number]
export type FeedUpdate = InferRequestType<Rpc['api']['feed'][':guid']['$patch']>['json']

export type FeedItemPreview = Json<Rpc['api']['queue']['$get']>['items'][number]
export type FeedItem = Json<Rpc['api']['feeditem'][':guid']['$get']>
export type FeedItemUpdate = InferRequestType<Rpc['api']['feeditem'][':guid']['$patch']>['json']
export type AdjacentFeedItems = Json<Rpc['api']['feeditem'][':guid']['adjacent']['$get']>

export type NotificationsResponse = Json<Rpc['api']['notification']['$get']>
export type Notification = NotificationsResponse['items'][number]
export type NotificationType = Notification['type']

export type Transcript = Json<Rpc['api']['feeditem'][':guid']['transcript']['$get']>[number]
export type TranscriptFull = Json<Rpc['api']['transcript'][':id']['$get']>
export type TranscriptStatus = Transcript['status']

/** One entry of a transcript's `segments_json` once parsed. */
export interface TranscriptSegment {
    start?: number
    end?: number
    text?: string
}
