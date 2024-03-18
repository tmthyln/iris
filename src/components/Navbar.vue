<script setup lang="ts">
import {ref} from "vue";

const logoSrc = new URL('../assets/icon.svg', import.meta.url).href;

const showSearch = ref(false)
</script>

<template>
  <nav class="navbar" role="navigation" aria-label="main navigation">
    <div class="navbar-brand">
      <router-link class="navbar-item" :to="{name: 'home'}">
        <img class="mr-2" :src="logoSrc" height="28" alt="logo">
        <span class="title is-4">Iris Aggregator</span>
      </router-link>
    </div>

    <div class="navbar-menu">
      <div class="navbar-end">
        <div class="navbar-item">
          <input class="input" type="search" placeholder="Search posts and podcasts" readonly @click="showSearch = true">
        </div>
      </div>
    </div>

    <div class="modal" :class="{'is-active': showSearch}">
      <div class="modal-background is-transparent" @click="showSearch = false"/>
      <div class="modal-card">
        <header class="modal-card-head">
          <p class="modal-card-title">Search blog posts and podcasts</p>
          <button class="delete" aria-label="close" @click="showSearch = false"/>
        </header>
        <section class="modal-card-body">
          <!-- Content ... -->
        </section>
      </div>
    </div>
  </nav>
</template>

<style scoped>

</style>