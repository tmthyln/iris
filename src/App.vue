<script setup lang="ts">
import Sidebar from "./components/Sidebar.vue";
import Navbar from "./components/Navbar.vue";
import {useFeedStore} from "./stores/feeds.ts";
import {onMounted} from "vue";

const feedStore = useFeedStore()

onMounted(feedStore.loadFeeds)
</script>

<template>
  <Navbar/>
  <div class="columns">
    <Sidebar class="column is-one-quarter is-narrow ml-4 mt-5"/>
    <RouterView class="column container"/>
  </div>
</template>

<style scoped>
</style>