<script setup lang="ts">
import {computed} from "vue";
import {useFetch, useTimeAgo} from "@vueuse/core";
import {useFeedStore} from "../stores/feeds.ts";
import {FeedItem} from "../types.ts";
import {useUnescapedHTML} from "../htmlproc.ts";
import Controls from "./Controls.vue";

const props = defineProps<{
    guid: string,
}>()

const itemDataUrl = computed(() => `/api/feeditem/${encodeURIComponent(props.guid)}`)
const {isFetching, data: feedItem} = useFetch<FeedItem>(itemDataUrl, {initialData: {title: 'Loading title...'}, refetch: true}).json()

const feedStore = useFeedStore()
const feed = computed(() => !isFetching && feedItem ? (feedStore.getFeedById(feedItem.source_feed) ?? {}) : {})
</script>

<template>
  <div class="section">

    <h1 class="title is-1">
      <component :is="feedItem.link ? 'a' : 'span'" :href="feedItem.link">
        {{ useUnescapedHTML(feedItem.title).value }}
      </component>
    </h1>
    <div class="breadcrumb has-dot-separator subtitle" aria-label="breadcrumbs">
      <ul>
        <li v-if="feed?.title"><router-link :to="{name: 'subscription', params: {guid: feed.guid}}">{{ feed.title }}</router-link></li>
        <li class="is-active" v-if="feedItem.season"><a disabled>Season {{ feedItem.season }}</a></li>
        <li class="is-active" v-if="feedItem.episode"><a disabled>Episode {{ feedItem.episode }}</a></li>
      </ul>
    </div>
    <div class="mb-4">
      <span
          v-for="keyword in feedItem.keywords" :key="keyword"
          class="tag is-info is-light mr-2">
        {{ keyword }}
      </span>
    </div>

    <div class="mb-5">Published {{ useTimeAgo(feedItem?.date).value }}</div>

    <Controls v-if="feedItem" :feed-item="feedItem"/>

    <hr>

    <div v-if="!feedItem?.encoded_content" class="content" v-html="feedItem?.description"></div>
    <div class="content" v-html="feedItem?.encoded_content"></div>

    <hr class="my-6">

    <div class="level px-4">
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