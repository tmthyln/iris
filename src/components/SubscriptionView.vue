<script setup lang="ts">
import ItemPreview from "./ItemPreview.vue";

const props = defineProps<{
    guid: string,
}>();


</script>

<template>
  <div class="section">

    <h1 class="title is-1">Subscription Name</h1>
    <small class="subtitle">Name of authors, author name</small>

    <div class="mt-4">description  description description</div>

    <section class="mt-6">
      <h2 class="title is-2">All Items</h2>

      <ItemPreview class="mb-6"/>
      <ItemPreview class="mb-6"/>
      <ItemPreview class="mb-6"/>
    </section>
  </div>
</template>

<style scoped>
</style>