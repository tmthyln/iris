<script setup lang="ts">
import {FeedItemPreview} from "../types.ts";
import {useTimeAgo} from "@vueuse/core";
import {useFeedStore} from "../stores/feeds.ts";
import {computed} from "vue";

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
      <figure class="image is-64x64 ml-3 mr-4">
        <img v-if="feed.image_src" :src="feed.image_src" :alt="feed.image_alt">
      </figure>
      <div class="is-inline-block">
        <small>Posted {{ formattedPubDate }}</small>

        <h3 class="title is-3">
          <router-link :to="{name: 'item', params: {guid: feedItem.guid}}">
            {{ feedItem.title }}
          </router-link>
        </h3>
        <div class="subtitle">
          From <router-link :to="{name: 'subscription', params: {guid: feed.guid}}"><em>{{ feed.title }}</em></router-link>
        </div>
      </div>

    </div>

    <!-- TODO: remove this injection vulnerability -->
    <div class="content" v-html="feedItem.description">
    </div>
  </div>
</template>

<style scoped>

</style>