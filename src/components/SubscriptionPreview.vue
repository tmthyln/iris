<script setup lang="ts">
import {computed, toRef} from 'vue';
import {Feed} from "../types.ts";
import {useUnescapedHTML} from "../htmlproc.ts";
import {usePlaceholderImage} from "../placeholderImage.ts";

const props = defineProps<{
    feed: Feed,
}>()

const displayTitle = computed(() => props.feed.alias || useUnescapedHTML(props.feed.title).value)
const displayAuthor = computed(() => useUnescapedHTML(props.feed.author).value)
const showAuthor = computed(() =>
    displayAuthor.value.trim() !== '' && displayAuthor.value.trim() !== displayTitle.value.trim()
)

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
            @error="onImageError"
          >
        </div>

        <figcaption class="mt-2">
          <div class="clamp-2-lines" :title="displayTitle">
            {{ displayTitle }}
          </div>
          <small v-if="showAuthor" class="clamp-2-lines" :title="displayAuthor">{{ displayAuthor }}</small>
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

.clamp-2-lines {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>