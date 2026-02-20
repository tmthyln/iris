<script setup lang="ts">
import SidePanel from "./components/SidePanel.vue";
import NavBar from "./components/NavBar.vue";
import {useFeedStore} from "./stores/feeds.ts";
import {useQueueStore} from "./stores/queue.ts";
import {useDownloadStore} from "./stores/downloads.ts";
import {onMounted, ref} from "vue";
import {useRouter} from "vue-router";
import AudioPlayer from "./components/AudioPlayer.vue";

const feedStore = useFeedStore()
const queueStore = useQueueStore()
const downloadStore = useDownloadStore()

onMounted(() => {
    feedStore.loadFeeds()
    queueStore.loadQueue()
    downloadStore.init()
})

const sidebarOpen = ref(false)
const router = useRouter()
router.afterEach(() => { sidebarOpen.value = false })

function handleExternalLinks(e: MouseEvent) {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor || !anchor.href) return
    const url = new URL(anchor.href, location.href)
    if (url.origin !== location.origin) {
        e.preventDefault()
        window.open(anchor.href, '_blank', 'noopener')
    }
}
</script>

<template>
  <div @click="handleExternalLinks">
    <NavBar v-model:sidebar-open="sidebarOpen"/>
    <div class="sidebar-backdrop is-hidden-tablet" v-if="sidebarOpen" @click="sidebarOpen = false"/>
    <div class="columns">
      <SidePanel class="column is-one-quarter is-narrow ml-4 mt-5 sidebar" :class="{'is-hidden-mobile': !sidebarOpen}"/>
      <RouterView class="column is-three-quarters container"/>
    </div>
    <AudioPlayer/>
  </div>
</template>

<style scoped>
.sidebar-backdrop {
  position: fixed;
  top: var(--bulma-navbar-height);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 29;
  background: rgba(0, 0, 0, 0.3);
}

@media screen and (max-width: 768px) {
  .sidebar {
    position: fixed;
    top: var(--bulma-navbar-height);
    right: 0;
    bottom: 0;
    z-index: 30;
    width: 80vw;
    max-width: 20rem;
    overflow-y: auto;
    background: hsl(var(--bulma-scheme-h), var(--bulma-scheme-s), var(--bulma-scheme-main-l));
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.15);
    padding: 1rem;
    margin: 0 !important;
  }
}
</style>