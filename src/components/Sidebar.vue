<script setup lang="ts">

</script>

<template>
  <aside>
    <p class="menu-label">Category A</p>

    <ul class="menu-list">
      <li><router-link :to="{name: 'subscription', params: {guid: 'jifej5if-3huf388fedhf'}}">Podcast</router-link></li>
      <li><router-link :to="{name: 'subscription', params: {guid: 'jifej5if-3huf388fedhf'}}" class="is-active">Someone's Blog</router-link></li>
      <li><router-link :to="{name: 'subscription', params: {guid: 'jifej5if-3huf388fedhf'}}">Other Podcast</router-link></li>
      <li><router-link :to="{name: 'subscription', params: {guid: 'jifej5if-3huf388fedhf'}}">Personal Blog &amp; Comics</router-link></li>
    </ul>

    <p class="menu-label">Category 2</p>

    <ul class="menu-list">
      <li><a>Some Podcast</a></li>
      <li><a>A Certain Blog</a></li>
      <li><a>Subscription Name</a></li>
    </ul>

    <p class="menu-label">Category 2</p>

    <ul class="menu-list">
      <li><a>Some Podcast</a></li>
      <li><a>A Certain Blog</a></li>
      <li><a>Subscription Name</a></li>
    </ul>

  </aside>
</template>

<style scoped>
</style>