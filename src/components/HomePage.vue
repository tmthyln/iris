<script setup lang="ts">
import SubscriptionPreview from "./SubscriptionPreview.vue";
import {nextTick, onMounted, ref} from "vue";
import {useIntersectionObserver, useTitle} from "@vueuse/core";
import ItemPreview from "./ItemPreview.vue";
import {useFeedStore} from "../stores/feeds.ts";
import {useFeedItemStore} from "../stores/feeditems.ts";

const feedStore = useFeedStore()
const feedItemStore = useFeedItemStore()
onMounted(feedItemStore.loadRecentUnreadItems)
useTitle('Iris')

const loadMoreSentinel = ref<HTMLElement>()
useIntersectionObserver(loadMoreSentinel, ([entry]) => {
    if (entry.isIntersecting) {
        feedItemStore.loadMoreRecentItems()
    }
})

const showFeedAdder = ref(false)
const feedUrl = ref('')
const feedUrlEl = ref<HTMLInputElement>()
const opmlFileInput = ref<HTMLInputElement>()
const opmlImportStatus = ref<{current: number, total: number, name: string} | null>(null)

function openFeedAdder() {
    feedUrl.value = ''
    opmlImportStatus.value = null
    showFeedAdder.value = true
    nextTick(() => feedUrlEl.value?.focus())
}

function closeFeedAdder() {
    showFeedAdder.value = false
}

async function submitFeedURL() {
    if (feedUrl.value === '') {
        closeFeedAdder()
        return
    }

    if (!feedUrl.value.startsWith('http')) {
        feedUrl.value = `https://${feedUrl.value}`
    }

    await fetch('/api/feed', {
        method: 'POST',
        body: JSON.stringify({url: feedUrl.value}),
    })

    closeFeedAdder()
}

async function importOpml(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file) return

    const text = await file.text()
    const parser = new DOMParser()
    const doc = parser.parseFromString(text, 'text/xml')
    const outlines = doc.querySelectorAll('outline[xmlUrl]')

    const feeds = Array.from(outlines).map(el => ({
        url: el.getAttribute('xmlUrl')!,
        name: el.getAttribute('text') ?? el.getAttribute('xmlUrl')!,
    }))

    for (let i = 0; i < feeds.length; i++) {
        opmlImportStatus.value = {current: i + 1, total: feeds.length, name: feeds[i].name}
        await fetch('/api/feed', {
            method: 'POST',
            body: JSON.stringify({url: feeds[i].url}),
        })
    }

    opmlImportStatus.value = null
    closeFeedAdder()
    feedStore.loadFeeds()

    // reset file input so the same file can be re-imported
    if (opmlFileInput.value) opmlFileInput.value.value = ''
}
</script>

<template>
  <div>

    <section class="section pb-4">
      <div class="is-flex is-align-items-center mb-4">
        <h2 class="title is-2 mb-0">Subscribed Feeds</h2>
        <button class="button is-small is-primary ml-5" @click="openFeedAdder">Add Feed</button>
      </div>

      <div class="is-flex subscriptions-list">
        <SubscriptionPreview
            v-for="feed in feedStore.feeds.filter(f => f.has_unread)" :key="feed.guid"
            :feed="feed"
            class="mr-4"/>
        <div v-if="feedStore.feedsLoadState !== 'loaded'">
          Loading feeds...
        </div>
        <div v-else-if="feedStore.feeds.length === 0">
          You aren't subscribed to any feeds! Add a feed to see them here.
        </div>
      </div>
    </section>

    <section class="section">
      <h2 class="title is-2">Recent Unread Items</h2>

      <div>
        <ItemPreview
            v-for="feedItem in feedItemStore.recentItems" :key="feedItem.guid"
            :feed-item="feedItem"
            class="mb-6"/>
        <div v-if="feedItemStore.recentItems.length === 0 && feedItemStore.recentLoadState === 'loaded'">
          You don't have any unread items from any feeds. Yay, inbox zero!
        </div>
        <div v-if="feedItemStore.recentHasMore" ref="loadMoreSentinel" class="has-text-centered py-4">
          <span v-if="feedItemStore.recentLoadState === 'loading'" class="has-text-grey">Loading...</span>
        </div>
      </div>
    </section>

    <div class="modal" :class="{'is-active': showFeedAdder}">
      <div class="modal-background" @click="closeFeedAdder"/>
      <div class="modal-card">
        <header class="modal-card-head">
          <p class="modal-card-title">Add a feed by URL</p>
          <button class="delete" aria-label="close" @click="closeFeedAdder"></button>
        </header>
        <section class="modal-card-body">
          <div class="field">
            <label class="label">Feed URL</label>
            <div class="control">
              <input
                  ref="feedUrlEl"
                  class="input" type="url"
                  v-model="feedUrl"
                  placeholder="https://example.com/feed.xml"
                  @keyup.enter="submitFeedURL">
            </div>
          </div>
        </section>
        <footer class="modal-card-foot is-gap-2">
          <button class="button is-success" @click="submitFeedURL">Submit</button>
          <button class="button" @click="closeFeedAdder">Cancel</button>
          <div class="ml-auto">
            <input ref="opmlFileInput" type="file" accept=".opml,.xml" class="is-hidden" @change="importOpml">
            <button class="button is-small is-text" @click="opmlFileInput?.click()">Import OPML</button>
          </div>
        </footer>
        <div v-if="opmlImportStatus" class="px-4 py-3">
          <progress class="progress is-small is-info" :value="opmlImportStatus.current" :max="opmlImportStatus.total"></progress>
          <p class="is-size-7 has-text-grey">
            Importing {{ opmlImportStatus.current }}/{{ opmlImportStatus.total }}: {{ opmlImportStatus.name }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.subscriptions-list {
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--bulma-border) transparent;
}

.subscriptions-list::-webkit-scrollbar {
  height: 6px;
}

.subscriptions-list::-webkit-scrollbar-track {
  background: transparent;
}

.subscriptions-list::-webkit-scrollbar-thumb {
  background: var(--bulma-border);
  border-radius: 3px;
}

.subscriptions-list::-webkit-scrollbar-thumb:hover {
  background: var(--bulma-border-hover);
}
</style>
