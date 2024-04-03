<script setup lang="ts">
import {FeedItemPreview} from "../types.ts";
import {useTimeAgo} from "@vueuse/core";
import {useFeedStore} from "../stores/feeds.ts";
import {computed} from "vue";
import {useUnescapedHTML} from "../htmlproc.ts";
import Controls from "./Controls.vue";

const props = defineProps<{
    feedItem: FeedItemPreview,
}>();

const feedStore = useFeedStore()
const feed = computed(() => feedStore.getFeedById(props.feedItem.source_feed))
const formattedPubDate = useTimeAgo(props.feedItem.date)
</script>

<template>
  <div>
    <div class="is-flex is-align-items-center mb-4">
      <figure v-if="feed.image_src" class="image is-64x64 ml-3 mr-4">
        <img :src="feed.image_src" :alt="feed.image_alt">
      </figure>
      <div class="is-inline-block">
        <small>Posted {{ formattedPubDate }}</small>

        <h3 class="title is-3">
          <router-link :to="{name: 'item', params: {guid: feedItem.guid}}">
            {{ useUnescapedHTML(feedItem.title).value }}
          </router-link>
        </h3>
        <div class="subtitle">
          From <router-link :to="{name: 'subscription', params: {guid: feed.guid}}"><em>{{ feed.title }}</em></router-link>
        </div>
      </div>
    </div>

    <Controls :feed-item="feedItem"/>

    <!-- TODO: remove this injection vulnerability -->
    <div class="content" v-html="feedItem.description">
    </div>
  </div>
</template>

<style scoped>

</style>