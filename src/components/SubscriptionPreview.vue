<script setup lang="ts">
import {Feed} from "../types.ts";
import {useUnescapedHTML} from "../htmlproc.ts";

defineProps<{
    feed: Feed,
}>()
</script>

<template>
  <div>
    <router-link :to="{name: 'subscription', params: {guid: feed.guid }}">
      <figure>

        <picture class="image is-128x128">
          <source :srcset="feed.image_src"/>
          <img
              src="https://bulma.io/images/placeholders/128x128.png"
              :alt="feed.image_alt ?? 'No feed image'">
        </picture>

        <figcaption class="mt-2">
          <div>{{ useUnescapedHTML(feed.title).value }}</div>
          <small>{{ useUnescapedHTML(feed.author).value }}</small>
        </figcaption>

      </figure>
    </router-link>
  </div>
</template>

<style scoped>

</style>