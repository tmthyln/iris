<script setup lang="ts">
const props = defineProps<{
    guid: string,
}>()
</script>

<template>
  <div>

    <h1 class="title is-1">Post or Episode Title</h1>

    <div class="content">
      decoded and escaped context (post content or podcast show notes)
    </div>

    <div class="level px-4 mt-6">
      <div class="level-left">
        <button class="button">Previous</button>
      </div>
      <div class="level-right">
        <button class="button">Next</button>
      </div>
    </div>

  </div>
</template>

<style scoped>
</style>