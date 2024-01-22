<script setup lang="ts">
import SubscriptionPreview from "./SubscriptionPreview.vue";
import {ref} from "vue";

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
</script>

<template>
  <div>

    <section class="section">
      <h2 class="is-flex is-align-items-center title is-3">
        Subscriptions
        <button class="button is-small is-primary ml-5" aria-hidden="true" @click="showFeedAdder = true">Add Feed</button>
      </h2>

      <div>
        <SubscriptionPreview/>
      </div>
    </section>

    <section class="section">
      <h2 class="title is-3">
        Everything
      </h2>


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