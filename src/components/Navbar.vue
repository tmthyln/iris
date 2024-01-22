<script setup lang="ts">

</script>

<template>
  <nav class="navbar" role="navigation" aria-label="main navigation">
    <div class="navbar-brand">
      <router-link class="navbar-item" :to="{name: 'home'}">
        <img src="https://bulma.io/images/bulma-logo.png" width="112" height="28">
      </router-link>

      <a role="button" class="navbar-burger" aria-label="menu" aria-expanded="false" data-target="navbarBasicExample">
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
      </a>
    </div>

    <div id="navbarBasicExample" class="navbar-menu">
      <div class="navbar-end">
        <div class="navbar-item">
          <input class="input" type="search" placeholder="Search posts and podcasts">
        </div>
      </div>
    </div>
  </nav>
</template>

<style scoped>

</style>