<script setup lang="ts">
import ItemPreview from "./ItemPreview.vue";
import {useFeedStore} from "../stores/feeds.ts";
import {computed} from "vue";
import {useFetch} from "@vueuse/core";

const props = defineProps<{
    guid: string,
}>();

const feedStore = useFeedStore();
const feed = computed(() => feedStore.getFeedById(props.guid))

const feedItemsUrl = computed(() => `/api/feed/${props.guid}/feeditem`)
const {data: feedItems} = useFetch(feedItemsUrl).json()
</script>

<template>
  <div class="section">

    <h1 class="title is-1">{{ feed.title }}</h1>
    <small class="subtitle">{{ feed.author }}</small>

    <div class="mt-4">{{ feed.description }}</div>

    <div class="mt-5">
      <em>
        Updates about every {{ feed.update_frequency }} day{{ feed.update_frequency === 1 ? '' : 's' }}
      </em>
    </div>

    <section class="mt-6">
      <h2 class="title is-2">All Items</h2>

      <ItemPreview
          v-for="feedItem in feedItems" :key="feedItem.guid"
          :feed-item="feedItem"
          class="mb-6"/>
    </section>
  </div>
</template>

<style scoped>
</style>