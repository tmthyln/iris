<script setup lang="ts">
import {Feed} from "../types.ts";

defineProps<{
    feed: Feed,
}>()
</script>

<template>
  <div>
    <router-link :to="{name: 'subscription', params: {guid: feed.guid }}">
      <figure class="image is-128x128">

        <img v-if="feed.image_src" :src="feed.image_src" :alt="feed.image_alt">
        <img v-else src="https://bulma.io/images/placeholders/128x128.png" alt="No podcast image">

        <figcaption class="mt-1">
          <div>{{ feed.title }}</div>
          <small>{{ feed.author }}</small>
        </figcaption>
      </figure>
    </router-link>
  </div>
</template>

<style scoped>

</style>