
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
}

export interface FeedItemPreview {
    guid: string
    source_feed: string
    season: number | null
    episode: number | null
    title: string
    description: string
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
}

export interface FeedItem extends FeedItemPreview {
    encoded_content: string | null
}
