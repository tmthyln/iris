<script setup lang="ts">
const props = defineProps<{
    guid: string,
}>()
</script>

<template>
  <div class="section">

    <h1 class="title is-1">Post or Episode Title</h1>
    <div class="subtitle">Work Chronicles by workchronicles author</div>

    <div class="mb-5">Published at Jan 22, 2024 at 13:20</div>

    <div class="mb-5">
      <audio controls>
        <source src="https://media.transistor.fm/0d0398b6/fea91837.mp3" type="audio/mpeg">
        Your browser does not support the audio element.
        Download the <a href="https://media.transistor.fm/0d0398b6/fea91837.mp3" download>audio file</a>
        to listen to this episode on your computer.
      </audio>
    </div>

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