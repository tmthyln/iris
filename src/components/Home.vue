<script setup lang="ts">
import SubscriptionPreview from "./SubscriptionPreview.vue";
import {ref} from "vue";
import ItemPreview from "./ItemPreview.vue";
import {useFeedStore} from "../stores/feeds.ts";
import {useFetch} from "@vueuse/core";

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
        })
    })
}

const feedStore = useFeedStore()

const { isFetching, data: allFeedItems } = useFetch('/api/feeditem?limit=20').json()
</script>

<template>
  <div>

    <section class="section">
      <h2 class="is-flex is-align-items-center title is-2">
        Subscriptions
        <button class="button is-small is-primary ml-5" aria-hidden="true" @click="showFeedAdder = true">Add Feed</button>
      </h2>

      <div class="is-flex mb-6">
        <SubscriptionPreview
            v-for="feed in feedStore.feeds" :key="feed.guid"
            :feed="feed"
            class="mr-4"/>
      </div>
    </section>

    <section class="section">
      <h2 class="title is-2">
        Recent Unread
      </h2>

      <div>
        <ItemPreview
            v-for="feedItem in allFeedItems" :key="feedItem.guid"
            :feed-item="feedItem"
            class="mb-6"/>
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