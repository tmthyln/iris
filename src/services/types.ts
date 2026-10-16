import type {TaskTrace} from './utils/log'


export interface RefreshFeedTask {
    readonly type: 'refresh-feed'
    readonly feedGuid: string
}

export interface PlanFeedArchivesTask {
    readonly type: 'plan-feed-archives'
    readonly feedGuid: string
}

export interface FetchArchiveSnapshotTask {
    readonly type: 'fetch-archive-snapshot'
    readonly feedSourceUrl: string
    readonly feedGuid: string
    readonly timestamp: number
    readonly snapshotUrl: string
}

export interface TranscribeFeedItemTask {
    readonly type: 'transcribe-feed-item'
    readonly transcriptId: number
}

/** Ids of the request (or cron run) that caused a task; see utils/log.ts. */
export interface Traced {
    readonly trace?: TaskTrace
}

export type FeedProcessingTask = (RefreshFeedTask | PlanFeedArchivesTask | FetchArchiveSnapshotTask | TranscribeFeedItemTask) & Traced

export interface FetchSuccessFileResult {
    readonly status: 'success'
    readonly content: string
    readonly metadata: {
        readonly timestamp: string
        readonly requestUrl: string
        readonly sha256Hash: string
    }
}

export interface FetchFailureFileResult {
    readonly status: 'error'
    readonly content: null
    readonly reason: string
}

export type FetchFileResult = FetchSuccessFileResult | FetchFailureFileResult
