<script setup lang="ts">
import {useFeedStore} from "../stores/feeds.ts";
import {computed, onMounted} from "vue";
import {useFeedItemStore} from "../stores/feeditems.ts";

const feedStore = useFeedStore()
const feedItemStore = useFeedItemStore()
onMounted(feedItemStore.loadBookmarkedItems)

const bookmarkedItems = computed(() => feedItemStore.bookmarked)
</script>

<template>
  <aside class="menu">
    <div v-if="feedStore.feeds.length === 0">
      No feeds! Add a feed to get started.
    </div>
    <div v-else-if="Object.keys(feedStore.feedsByCategory).length <= 1">
      No categories! Add a category on a feed to see them here.
    </div>

    <template v-for="(catFeeds, category) in feedStore.feedsByCategory">
      <p class="menu-label has-text-info">{{ category }}</p>

      <ul class="menu-list">
        <li v-for="feed in catFeeds" :key="feed.guid">
          <router-link :to="{name: 'subscription', params: {guid: feed.guid}}">
            {{ feed.title }}
          </router-link>
        </li>
      </ul>
    </template>

    <hr>

    <p class="menu-label has-text-primary">Bookmarked Items</p>

    <div v-if="feedItemStore.bookmarked.length === 0">
      No bookmarks! Bookmark an item to access them quickly here.
    </div>
    <ul class="menu-list">
      <li
          v-for="feedItem in bookmarkedItems" :key="feedItem.guid"
          class="is-inline-flex">
        <router-link :to="{name: 'item', params: {guid: feedItem.guid}}">
          {{ feedItem.title }}
        </router-link>
        <span
            class="button material-symbols-outlined has-text-warning"
            style="border: none;"
            title="Unbookmark this item"
            @click="feedItemStore.unbookmarkItem(feedItem)">
          bookmark_remove
        </span>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
</style>