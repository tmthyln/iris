<script setup lang="ts">
import {computed} from "vue";
import {useTitle} from "@vueuse/core";
import {useDownloadStore} from "../stores/downloads.ts";
import AudioControls from "./AudioControls.vue";

useTitle('Downloads — Iris')

const downloadStore = useDownloadStore()

const sortedItems = computed(() => {
    return Object.values(downloadStore.downloadedItems).sort((a, b) => {
        const statusA = downloadStore.statuses[a.guid]
        const statusB = downloadStore.statuses[b.guid]
        const dateA = typeof statusA === 'object' && statusA.state === 'downloaded' ? statusA.downloadedAt : ''
        const dateB = typeof statusB === 'object' && statusB.state === 'downloaded' ? statusB.downloadedAt : ''
        return dateB.localeCompare(dateA)
    })
})

function formatSize(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDownloadedAt(guid: string): string {
    const status = downloadStore.statuses[guid]
    if (typeof status !== 'object' || status.state !== 'downloaded') return ''
    return new Date(status.downloadedAt).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'})
}

function getSize(guid: string): string {
    const status = downloadStore.statuses[guid]
    if (typeof status !== 'object' || status.state !== 'downloaded') return ''
    return formatSize(status.size)
}
</script>

<template>
  <div class="section">
    <div class="is-flex is-align-items-baseline mb-4">
      <h1 class="title mb-0">Downloads</h1>
      <span v-if="downloadStore.totalStorageUsed > 0" class="has-text-grey ml-4">
        {{ formatSize(downloadStore.totalStorageUsed) }} used
      </span>
    </div>

    <div v-if="sortedItems.length === 0" class="has-text-grey">
      No downloaded items. Items added to the queue are downloaded automatically.
    </div>

    <div v-for="item in sortedItems" :key="item.guid" class="box mb-4">
      <div class="is-flex is-justify-content-space-between is-align-items-baseline mb-2">
        <router-link :to="{name: 'item', params: {guid: item.guid}}" class="has-text-weight-semibold">
          {{ item.title }}
        </router-link>
        <span class="has-text-grey is-size-7 ml-3 is-flex-shrink-0">
          {{ getSize(item.guid) }} &middot; {{ formatDownloadedAt(item.guid) }}
        </span>
      </div>
      <AudioControls :feed-item="item"/>
    </div>
  </div>
</template>
