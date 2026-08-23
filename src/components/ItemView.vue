<script setup lang="ts">
import {computed, onMounted, ref, watch} from "vue";
import {useTimeAgo, useTitle} from "@vueuse/core";
import {useRouter} from "vue-router";
import {useFeedStore} from "../stores/feeds.ts";
import {useFeedItemStore} from "../stores/feeditems.ts";
import {AdjacentFeedItems, Feed, FeedItem} from "../types.ts";
import {useUnescapedHTML} from "../htmlproc.ts";
import AudioControls from "./AudioControls.vue";
import TranscriptView from "./TranscriptView.vue";
import client from '../client'

const props = defineProps<{
    guid: string,
}>()

const router = useRouter()
const feedStore = useFeedStore()
const feedItemStore = useFeedItemStore()

const feedItem = ref<FeedItem | null>(null)
const feed = ref<Feed | null>(null)
const isFetchingItem = ref(true)
const adjacent = ref<AdjacentFeedItems>({ prev: null, next: null })
const transcriptOpen = ref(false)
useTitle(computed(() => feedItem.value ? `${feedItem.value.title} — Iris` : 'Iris'))
async function fetchFeedItem() {
    const guid = props.guid
    const [data, adjacentData] = await Promise.all([
        feedItemStore.loadFullItem(guid),
        feedItemStore.loadAdjacent(guid),
    ])
    // Bail out if the user navigated away while we were loading.
    if (guid !== props.guid) return

    if (data) {
        feedItem.value = data;
        isFetchingItem.value = false

        await feedStore.afterFeedsLoaded(async () => {
            feed.value = feedStore.getFeedById(data.source_feed)

            if (feed.value?.type === 'blog' && !data.finished && feedItem.value) {
                await client.modifyFeedItem(data.guid, { finished: true })
                feedItem.value.finished = true
            }
        })
    }
    if (adjacentData) {
        adjacent.value = adjacentData
        if (adjacentData.prev) feedItemStore.prefetchItem(adjacentData.prev.guid)
        if (adjacentData.next) feedItemStore.prefetchItem(adjacentData.next.guid)
    }
}
function navigateTo(guid: string) {
    router.push({ name: 'item', params: { guid } })
}
watch(() => props.guid, () => {
    window.scrollTo(0, 0)
    fetchFeedItem()
})
onMounted(fetchFeedItem)
</script>

<template>
  <div class="section">

    <h1 class="title is-1">
      <component :is="feedItem?.link ? 'a' : 'span'" :href="feedItem?.link">
        {{ useUnescapedHTML(feedItem?.title ?? '').value }}
      </component>
    </h1>
    <div class="breadcrumb has-dot-separator subtitle" aria-label="breadcrumbs">
      <ul>
        <li v-if="feed?.title"><router-link :to="{name: 'subscription', params: {guid: feed.guid}}">{{ useUnescapedHTML(feed?.title).value }}</router-link></li>
        <li class="is-active" v-if="feedItem?.season"><a disabled>Season {{ feedItem?.season }}</a></li>
        <li class="is-active" v-if="feedItem?.episode"><a disabled>Episode {{ feedItem?.episode }}</a></li>
      </ul>
    </div>
    <div class="mb-4">
      <span
          v-for="keyword in feedItem?.keywords ?? []" :key="keyword"
          class="tag is-info is-light mr-2">
        {{ keyword }}
      </span>
    </div>

    <div class="mb-5" :title="feedItem?.date ? new Date(feedItem.date).toLocaleDateString(undefined, {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'}) : ''">Published {{ useTimeAgo(feedItem?.date ?? 0).value }}</div>

    <AudioControls v-if="feedItem" :feed-item="feedItem" show-transcript @open-transcript="transcriptOpen = true"/>
    <TranscriptView v-if="feedItem?.enclosure_url" :feed-item-guid="feedItem.guid" v-model:open="transcriptOpen"/>

    <hr>

    <div v-if="!feedItem?.encoded_content" class="content" v-html="feedItem?.description"></div>
    <div class="content" v-html="feedItem?.encoded_content"></div>

    <hr class="my-6">

    <div class="adjacent-nav px-4">
      <button
          class="button adjacent-button adjacent-prev"
          :disabled="!adjacent.prev"
          :title="adjacent.prev ? useUnescapedHTML(adjacent.prev.title).value : ''"
          @click="adjacent.prev && navigateTo(adjacent.prev.guid)"
      >
        <span class="adjacent-arrow">&larr;</span>
        <span class="adjacent-label">{{ adjacent.prev ? useUnescapedHTML(adjacent.prev.title).value : 'Previous' }}</span>
      </button>
      <button
          class="button adjacent-button adjacent-next"
          :disabled="!adjacent.next"
          :title="adjacent.next ? useUnescapedHTML(adjacent.next.title).value : ''"
          @click="adjacent.next && navigateTo(adjacent.next.guid)"
      >
        <span class="adjacent-label">{{ adjacent.next ? useUnescapedHTML(adjacent.next.title).value : 'Next' }}</span>
        <span class="adjacent-arrow">&rarr;</span>
      </button>
    </div>

  </div>
</template>

<style scoped>
.adjacent-nav {
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
}
.adjacent-button {
    flex: 1 1 0;
    min-width: 0;
    max-width: 100%;
}
.adjacent-prev {
    justify-content: flex-start;
}
.adjacent-next {
    justify-content: flex-end;
}
.adjacent-arrow {
    flex: 0 0 auto;
}
.adjacent-prev .adjacent-arrow {
    margin-right: 0.5rem;
}
.adjacent-next .adjacent-arrow {
    margin-left: 0.5rem;
}
.adjacent-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

@media (max-width: 768px) {
    .adjacent-nav {
        flex-wrap: wrap;
    }
    .adjacent-button {
        flex: 1 1 auto;
    }
}
</style>