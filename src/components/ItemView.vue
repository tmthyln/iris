<script setup lang="ts">
import {computed} from "vue";
import {useFetch, useTimeAgo} from "@vueuse/core";
import {useFeedStore} from "../stores/feeds.ts";
import {FeedItem} from "../types.ts";

const props = defineProps<{
    guid: string,
}>()

const itemDataUrl = computed(() => `/api/feeditem/${encodeURIComponent(props.guid)}`)
const {isFetching, data: feedItem} = useFetch<FeedItem>(itemDataUrl, {initialData: {title: 'Loading title...'}}).json()

const pubDate = useTimeAgo(feedItem.date)

const feedStore = useFeedStore()
const feed = computed(() => !isFetching && feedItem ? (feedStore.getFeedById(feedItem.source_feed) ?? {}) : {})
</script>

<template>
  <div class="section">

    <h1 class="title is-1">
      <component :is="feedItem.link ? 'a' : 'span'" :href="feedItem.link">
        {{ feedItem.title }}
      </component>
    </h1>
    <div v-if="feed" class="subtitle">{{ feed.title }}</div>
    <div class="breadcrumb has-dot-separator" aria-label="breadcrumbs">
      <ul>
        <li v-if="feed?.title"><router-link :to="{name: 'subscription', params: {guid: feed.guid}}">{{ feed.title }}</router-link></li>
        <li class="is-active" v-if="feedItem.season"><a disabled>Season {{ feedItem.season }}</a></li>
        <li class="is-active" v-if="feedItem.episode"><a disabled>Episode {{ feedItem.episode }}</a></li>
      </ul>
    </div>

    <div class="mb-5">Published {{ pubDate }}</div>

    <div v-if="feedItem.enclosure_url" class="mb-5">
      <audio controls>
        <source :src="feedItem.enclosure_url" :type="feedItem.enclosure_type">
        Your browser does not support the audio element.
        Download the <a :href="feedItem.enclosure_url" download>audio file</a>
        to listen to this episode on your computer.
      </audio>
    </div>

    <div class="content" v-html="feedItem.encoded_content"></div>

    <div class="level px-4 mt-6">
      <div class="level-left">
        <button class="button">Previous</button>
      </div>
      <div class="level-right">
        <button class="button">Next</button>
      </div>
    </div>

  </div>
</template>

<style scoped>
</style>