<script setup lang="ts">
import {FeedItemPreview} from "../types.ts";
import {useTimeAgo} from "@vueuse/core";
import {useFeedStore} from "../stores/feeds.ts";
import {computed, toRef} from "vue";
import {useUnescapedHTML} from "../htmlproc.ts";
import {usePlaceholderImage} from "../placeholderImage.ts";
import AudioControls from "./AudioControls.vue";

const props = defineProps<{
    feedItem: FeedItemPreview,
}>();

const feedStore = useFeedStore()
const feed = computed(() => feedStore.getFeedById(props.feedItem.source_feed))
const formattedPubDate = useTimeAgo(props.feedItem.date)

const {resolvedSrc, onImageError} = usePlaceholderImage(
    toRef(() => feed.value.image_src),
    toRef(() => feed.value.title),
    64
)
</script>

<template>
  <div>
    <div class="is-flex is-align-items-center mb-4">
      <figure class="image is-64x64 ml-3 mr-4">
        <img :src="resolvedSrc" :alt="feed?.image_alt ?? undefined" @error="onImageError">
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

    <AudioControls :feed-item="feedItem"/>

    <!-- TODO: remove this injection vulnerability -->
    <div v-if="feedItem.description" class="content" v-html="feedItem.description">
    </div>
  </div>
</template>

<style scoped>

</style>