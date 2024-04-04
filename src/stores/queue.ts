import {defineStore} from "pinia";
import {FeedItemPreview} from "../types.ts";

export const useQueueStore = defineStore('queue', {
    state() {
        return {

        }
    },
    actions: {
        itemIsPlaying(item: FeedItemPreview) {
            return false
        },
        itemQueued(item: FeedItemPreview) {
            return false
        },
        itemQueuedOrPlaying(item: FeedItemPreview) {
            return this.itemIsPlaying(item) || this.itemQueued(item)
        },
        addItem(item: FeedItemPreview) {
            // TODO implement
        },
        removeItem(item: FeedItemPreview) {
            // TODO implement
        },
    },
})
