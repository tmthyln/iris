<script setup lang="ts">
import {useFeedStore} from "../stores/feeds.ts";

const feedStore = useFeedStore()
</script>

<template>
  <aside class="menu">
    <div v-if="feedStore.feeds.length === 0">
      No feeds! Add a feed to get started.
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
  </aside>
</template>

<style scoped>
</style>