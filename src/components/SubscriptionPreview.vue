<script setup lang="ts">
import {computed, toRef} from 'vue';
import {Feed} from "../types.ts";
import {useUnescapedHTML} from "../htmlproc.ts";
import {usePlaceholderImage} from "../placeholderImage.ts";

const props = defineProps<{
    feed: Feed,
}>()

const {resolvedSrc, onImageError} = usePlaceholderImage(
    toRef(() => props.feed.image_src),
    toRef(() => props.feed.title),
    128
)
</script>

<template>
  <div>
    <router-link :to="{name: 'subscription', params: {guid: feed.guid }}">
      <figure>

        <div class="image is-128x128">
          <img
              :src="resolvedSrc"
              :alt="feed.image_alt ?? 'No feed image'"
              @error="onImageError">
        </div>

        <figcaption class="mt-2">
          <div>{{ useUnescapedHTML(feed.title).value }}</div>
          <small>{{ useUnescapedHTML(feed.author).value }}</small>
        </figcaption>

      </figure>
    </router-link>
  </div>
</template>

<style scoped>
figure {
  max-width: 128px;
}

figcaption {
  word-wrap: break-word;
}
</style>