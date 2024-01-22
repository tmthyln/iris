<script setup lang="ts">
const props = defineProps<{
    guid: string,
}>();


</script>

<template>
  <div>

    <h1 class="title is-1">Subscription Name</h1>
    <small class="subtitle">Name of authors, author name</small>
    <div>description  description description</div>
    {{ guid }}

    <h2 class="title is-2">All Items</h2>


  </div>
</template>

<style scoped>
</style>