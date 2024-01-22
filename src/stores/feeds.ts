import {defineStore} from "pinia";

interface Feed {
    guid: string,
    title: string,
    description: string,
    author: string,
    type: string,
    ongoing: boolean | null,
    active: boolean,
    image_src: string,
    image_alt: string,
    last_updated: string,
    link: string,
    categories: string[],
}

interface FeedItem {
    guid: string,
    sourceFeed: string,
    season: number | null,
    episode: number | null,
    title: string,
    description: string,
    link: string,
    date: string | null,
    enclosure_url: string | null,
    enclosure_length: number | null,
    enclosure_type: string | null,
    duration: number | null,
    duration_unit: string | null,
    encoded_content: string,
    keywords: string[],
    finished: boolean,
    progress: number | null,
}

export const useFeedStore = defineStore('feeds', {
    state() {
        return {

        }
    },
    getters: {

    },
    actions: {

    },
})
