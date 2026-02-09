<script setup lang="ts">
import SidePanel from "./components/SidePanel.vue";
import NavBar from "./components/NavBar.vue";
import {useFeedStore} from "./stores/feeds.ts";
import {useQueueStore} from "./stores/queue.ts";
import {onMounted} from "vue";
import AudioPlayer from "./components/AudioPlayer.vue";

const feedStore = useFeedStore()
const queueStore = useQueueStore()

onMounted(() => {
    feedStore.loadFeeds()
    queueStore.loadQueue()
})
</script>

<template>
  <NavBar/>
  <div class="columns">
    <SidePanel class="column is-one-quarter is-narrow ml-4 mt-5"/>
    <RouterView class="column is-three-quarters container"/>
  </div>
  <AudioPlayer/>
</template>

<style scoped>
</style>