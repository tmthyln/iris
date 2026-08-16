
export type LoadingState = 'unloaded' | 'loading' | 'loaded'

export interface Feed {
    guid: string
    source_url: string
    title: string
    alias: string
    description: string
    author: string
    type: 'podcast' | 'blog'
    ongoing: boolean | null
    active: boolean
    image_src: string | null
    image_alt: string | null
    last_updated: string
    update_frequency: number
    link: string
    categories: string[]
    notify_enabled: boolean
    has_unread: boolean
    has_archives: boolean
}

export type NotificationType = 'new_item' | 'updated_item'

export interface Notification {
    id: number
    type: NotificationType
    feed_guid: string
    feed_item_guid: string
    feed_title: string | null
    feed_alias: string | null
    item_title: string | null
    created_at: string
    dismissed: boolean
}

export interface NotificationsResponse {
    items: Notification[]
    unreadCount: number
}

export interface FeedItemPreview {
    guid: string
    source_feed: string
    season: number | null
    episode: number | null
    title: string
    description: string | null
    link: string
    date: string | null
    enclosure_url: string | null
    enclosure_length: number | null
    enclosure_type: string | null
    duration: number | null
    duration_unit: string | null
    keywords: string[]
    finished: boolean
    progress: number
    bookmarked: boolean
}

export interface FeedItem extends FeedItemPreview {
    encoded_content: string | null
}

export interface AdjacentFeedItems {
    prev: FeedItemPreview | null
    next: FeedItemPreview | null
}

export type TranscriptStatus = 'pending' | 'processing' | 'complete' | 'error'

export interface TranscriptSegment {
    start?: number
    end?: number
    text?: string
}

export interface Transcript {
    id: number
    feed_item_guid: string
    model: string
    language: string | null
    source_transcript_id: number | null
    status: TranscriptStatus
    error_message: string | null
    requested_at: string
    started_at: string | null
    completed_at: string | null
}

export interface TranscriptFull extends Transcript {
    text: string | null
    segments_json: string | null
}
