<script setup lang="ts">
import {ref} from "vue";

const showSearch = ref(false)
</script>

<template>
  <nav class="navbar" role="navigation" aria-label="main navigation">
    <div class="navbar-brand">
      <router-link class="navbar-item" :to="{name: 'home'}">
        <img src="https://bulma.io/images/bulma-logo.png" width="112" height="28" alt="logo">
      </router-link>

      <a role="button" class="navbar-burger" aria-label="menu" aria-expanded="false">
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
      </a>
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