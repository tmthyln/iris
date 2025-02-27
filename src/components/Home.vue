<script setup lang="ts">
import SubscriptionPreview from "./SubscriptionPreview.vue";
import {computed, onMounted, ref} from "vue";
import ItemPreview from "./ItemPreview.vue";
import {useFeedStore} from "../stores/feeds.ts";
import {useFetch} from "@vueuse/core";
import {useFeedItemStore} from "../stores/feeditems.ts";

const showFeedAdder = ref(false);

const feedUrl = ref('')
function updateFeedUrl(event: InputEvent) {
    feedUrl.value = (event.target as HTMLInputElement).value;
}

async function submitFeedURL() {
    if (feedUrl.value === '') {
        showFeedAdder.value = false;
        return;
    }

    if (!feedUrl.value.startsWith('http')) {
        feedUrl.value = `https://${feedUrl.value}`;
    }

    await fetch('/api/feed', {
        method: 'POST',
        body: JSON.stringify({
            url: feedUrl.value,
        }),
    })
}

const feedStore = useFeedStore()
const feedItemStore = useFeedItemStore()
onMounted(feedItemStore.loadRecentUnreadItems)

const allFeedItems = computed(() => feedItemStore.recentItems)
</script>

<template>
  <div>

    <section class="section pb-4">
      <h2 class="is-flex is-align-items-center title is-2">
        Subscribed Feeds
        <button class="button is-small is-primary ml-5" aria-hidden="true" @click="showFeedAdder = true">Add Feed</button>
      </h2>

      <div class="is-flex" style="overflow-x: scroll">
        <SubscriptionPreview
            v-for="feed in feedStore.feeds" :key="feed.guid"
            :feed="feed"
            class="mr-4"/>
        <div v-if="feedStore.feeds.length === 0">
          You aren't subscribed to any feeds! Add a feed to see them here.
        </div>
      </div>
    </section>

    <section class="section">
      <h2 class="title is-2">
        Recent Unread Items
      </h2>

      <div>
        <ItemPreview
            v-for="feedItem in allFeedItems" :key="feedItem.guid"
            :feed-item="feedItem"
            class="mb-6"/>
        <div v-if="feedStore.feeds.length === 0">
          You don't have any unread items from any feeds. Yay, inbox zero!
        </div>
      </div>
    </section>

    <div class="modal" :class="{'is-active': showFeedAdder}">
      <div class="modal-background" @click="showFeedAdder = false"></div>
      <div class="modal-card">
        <header class="modal-card-head">
          <p class="modal-card-title">Add a feed by URL</p>
          <button class="delete" aria-label="close" @click="showFeedAdder = false"></button>
        </header>
        <section class="modal-card-body">

          <div class="field">
            <label class="label">Input URL</label>
            <div class="control">
              <input class="input" type="url" :value="feedUrl" @input="updateFeedUrl"/>
            </div>
          </div>

          <button class="button is-success" @click="submitFeedURL">Submit URL</button>

        </section>
        <footer class="modal-card-foot">

        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>

</style>