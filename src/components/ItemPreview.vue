<script setup lang="ts">
defineProps<{
    subscription: any,
}>();
</script>

<template>
  <div>
    <small>5 days ago</small>

    <h3 class="title is-3"><router-link :to="{name: 'item', params: {guid: 'fjifjeij0=fut3ijijfeifhc-3jfj'}}">Episode or Post Title</router-link></h3>

    <div>
      This is the description. This is either the show notes if this item is a podcast episode or a snippet of the content
      if this is a blog post. If this item is an image (like a comic), then this is probably a description of the image or
      maybe alt text.
    </div>
  </div>
</template>

<style scoped>

</style>