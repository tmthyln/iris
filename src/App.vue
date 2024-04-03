<script setup lang="ts">
import Sidebar from "./components/Sidebar.vue";
import Navbar from "./components/Navbar.vue";
import {useFeedStore} from "./stores/feeds.ts";
import {onMounted} from "vue";
import AudioPlayer from "./components/AudioPlayer.vue";

const feedStore = useFeedStore()

onMounted(feedStore.loadFeeds)
</script>

<template>
  <Navbar/>
  <div class="columns">
    <Sidebar class="column is-one-quarter is-narrow ml-4 mt-5"/>
    <RouterView class="column is-three-quarters container"/>
  </div>
  <AudioPlayer/>
</template>

<style scoped>
</style>