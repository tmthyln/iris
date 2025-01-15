<script setup lang="ts">
import ItemPreview from "./ItemPreview.vue";
import {useFeedStore} from "../stores/feeds.ts";
import {computed, ref} from "vue";
import {useFetch} from "@vueuse/core";
import {useUnescapedHTML} from "../htmlproc.ts";

const props = defineProps<{
    guid: string,
}>();

const feedStore = useFeedStore();
const feed = computed(() => feedStore.getFeedById(props.guid))

const showFinished = ref(false);
const sortAscending = ref(false);
const feedItemsUrl = computed(() => `/api/feed/${props.guid}/feeditem?include_finished=${showFinished.value}&sort_order=${sortAscending.value ? 'asc' : 'desc'}`)
const {isFetching, data: feedItems} = useFetch(feedItemsUrl, {refetch: true}).json()
</script>

<template>
  <div class="section">

    <h1 class="title is-1">
      <component :is="feed?.link ? 'a' : 'span'" :href="feed?.link">
        {{ feed?.title ?? 'Loading subscription...' }}
      </component>
    </h1>
    <small class="subtitle">{{ useUnescapedHTML(feed.author).value }}</small>

    <div class="mt-4">{{ feed.description }}</div>

    <div class="mt-5">
      <em>
        Updates about once every {{ feed.update_frequency }} day{{ feed.update_frequency === 1 ? '' : 's' }}.
      </em>
    </div>

    <section class="mt-6">
      <div class="is-flex is-align-items-start">
        <h2 class="title is-2 mr-auto">{{ showFinished ? 'All' : 'Unseen' }} {{ feed?.type === 'podcast' ? 'Episodes' : 'Posts' }}</h2>

        <span
            class="button icon py-4 mr-2 is-outlined"
            :class="{'is-primary': sortAscending, 'is-info': !sortAscending, 'is-loading': isFetching}"
            :title="sortAscending? 'Sort by latest items first' : 'Sort by earliest items first'"
            @click="sortAscending = !sortAscending">
          <span class="material-symbols-outlined">swap_vert</span>
        </span>
        <span
            class="button icon py-4 is-outlined"
            :class="{'is-primary': showFinished, 'is-info': !showFinished, 'is-loading': isFetching}"
            :title="showFinished ? 'Hide finished items' : 'Show finished items'"
            @click="showFinished = !showFinished">
          <span class="material-symbols-outlined">{{ showFinished ? 'check_circle' : 'done' }}</span>
        </span>
      </div>


      <ItemPreview
          v-for="feedItem in feedItems" :key="feedItem.guid"
          :feed-item="feedItem"
          class="mb-6"/>
    </section>
  </div>
</template>

<style scoped>
</style>