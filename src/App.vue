<script setup lang="ts">
import Sidebar from "./components/Sidebar.vue";
import Navbar from "./components/Navbar.vue";

import {onMounted} from "vue";

onMounted(async () => {
    await fetch('/api/create', {
        method: 'POST',
    })
})
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
