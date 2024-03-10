<script setup lang="ts">
import {useFeedStore} from "../stores/feeds.ts";

const feedStore = useFeedStore()
</script>

<template>
  <aside>
    <template v-for="(catFeeds, category) in feedStore.feedsByCategory">
      <p class="menu-label">{{ category }}</p>

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