
export interface RefreshFeedTask {
    readonly type: 'refresh-feed'
    readonly feedGuid: string
}

export interface LoadFeedSourceArchivesTask {
    readonly type: 'load-feed-source-archives'
    readonly feedSourceUrl: string
}

export type FeedProcessingTask = RefreshFeedTask | LoadFeedSourceArchivesTask

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
