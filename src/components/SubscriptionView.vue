<script setup lang="ts">
import ItemPreview from "./ItemPreview.vue";
import {useFeedStore} from "../stores/feeds.ts";
import {computed, ref, watch} from "vue";
import {useIntersectionObserver, useSessionStorage, useTitle} from "@vueuse/core";
import {useUnescapedHTML} from "../htmlproc.ts";
import type {FeedItem} from "../types.ts";

const props = defineProps<{
    guid: string,
}>();

const feedStore = useFeedStore();
const feed = computed(() => feedStore.getFeedById(props.guid))
useTitle(computed(() => feed.value ? `${feed.value.title} — Iris` : 'Iris'))

const showFinished = useSessionStorage('feedView:showFinished', false);
const sortAscending = useSessionStorage('feedView:sortAscending', false);

const newCategory = ref('');
const showSuggestions = ref(false);
const highlightedIndex = ref(-1);
const suggestedCategories = computed(() =>
    feedStore.allCategories.filter(c => !feed.value?.categories.includes(c))
)
const filteredSuggestions = computed(() => {
    const query = newCategory.value.trim().toLowerCase()
    return !query
        ? suggestedCategories.value
        : suggestedCategories.value.filter(c => c.toLowerCase().includes(query))
})
watch(filteredSuggestions, () => {
    highlightedIndex.value = -1
})
function sanitizeCategoryInput() {
    newCategory.value = newCategory.value.replace(/,/g, '')
}
function onKeydown(e: KeyboardEvent) {
    const len = filteredSuggestions.value.length
    if (!showSuggestions.value || len === 0) return
    if (e.key === 'ArrowDown') {
        e.preventDefault()
        highlightedIndex.value = (highlightedIndex.value + 1) % len
    } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        highlightedIndex.value = highlightedIndex.value <= 0 ? -1 : highlightedIndex.value - 1
    }
}
function onEnter() {
    if (highlightedIndex.value >= 0 && highlightedIndex.value < filteredSuggestions.value.length) {
        selectSuggestion(filteredSuggestions.value[highlightedIndex.value])
    } else {
        addCategory()
    }
}
function selectSuggestion(category: string) {
    newCategory.value = category
    showSuggestions.value = false
    highlightedIndex.value = -1
    addCategory()
}
async function addCategory() {
    const value = newCategory.value.trim()
    if (!value || !feed.value) return
    showSuggestions.value = false
    highlightedIndex.value = -1
    if (feed.value.categories.includes(value)) {
        newCategory.value = ''
        return
    }
    await feedStore.updateFeedCategories(props.guid, [...feed.value.categories, value])
    newCategory.value = ''
}
async function removeCategory(category: string) {
    if (!feed.value) return
    await feedStore.updateFeedCategories(props.guid, feed.value.categories.filter(c => c !== category))
}
const menuOpen = ref(false)
const menuLoading = ref(false)

function closeMenu() {
    menuOpen.value = false
}

async function handleRefreshFeed() {
    menuLoading.value = true
    await feedStore.refreshFeed(props.guid)
    menuLoading.value = false
    menuOpen.value = false
}

async function handleFetchArchives() {
    menuLoading.value = true
    await feedStore.planFeedArchives(props.guid)
    menuLoading.value = false
    menuOpen.value = false
}

const PAGE_SIZE = 20
const feedItems = ref<FeedItem[]>([])
const isFetching = ref(false)
const hasMore = ref(true)

async function fetchPage(offset: number) {
    isFetching.value = true
    const params = new URLSearchParams({
        include_finished: String(showFinished.value),
        sort_order: sortAscending.value ? 'asc' : 'desc',
        limit: String(PAGE_SIZE),
        offset: String(offset),
    })
    const response = await fetch(`/api/feed/${props.guid}/feeditem?${params}`)
    isFetching.value = false
    if (response.ok) {
        const data: FeedItem[] = await response.json()
        hasMore.value = data.length >= PAGE_SIZE
        return data
    }
    return []
}

async function loadInitialPage() {
    feedItems.value = []
    hasMore.value = true
    feedItems.value = await fetchPage(0)
}

async function loadMore() {
    if (isFetching.value || !hasMore.value) return
    const data = await fetchPage(feedItems.value.length)
    feedItems.value.push(...data)
}

watch([() => props.guid, showFinished, sortAscending], loadInitialPage, {immediate: true})

const loadMoreSentinel = ref<HTMLElement>()
useIntersectionObserver(loadMoreSentinel, ([entry]) => {
    if (entry.isIntersecting) loadMore()
})
</script>

<template>
  <div class="section">

    <template v-if="feed">
    <h1 class="title is-1">
      <component :is="feed.link ? 'a' : 'span'" :href="feed.link">
        {{ feed.title }}
      </component>
    </h1>
    <small class="subtitle">{{ useUnescapedHTML(feed.author).value }}</small>

    <div class="mt-4">{{ feed.description }}</div>

    <div class="mt-4 is-flex is-align-items-center is-flex-wrap-wrap" style="gap: 0.5rem">
      <span v-for="category in feed.categories" :key="category" class="tag is-info is-medium">
        {{ category }}
        <button class="delete is-small" @click="removeCategory(category)"></button>
      </span>
      <div class="category-input-wrapper">
        <div class="field has-addons mb-0">
          <div class="control">
            <input
                v-model="newCategory"
                class="input is-small"
                type="text"
                placeholder="Add category"
                @input="sanitizeCategoryInput"
                @focus="showSuggestions = true"
                @blur="showSuggestions = false"
                @keydown="onKeydown"
                @keydown.enter.prevent="onEnter">
          </div>
          <div class="control">
            <button class="button is-small is-info" @click="addCategory">+</button>
          </div>
        </div>
        <div v-if="showSuggestions && filteredSuggestions.length > 0" class="category-suggestions">
          <div
              v-for="(cat, index) in filteredSuggestions" :key="cat"
              class="category-suggestion"
              :class="{ 'is-active': index === highlightedIndex }"
              @mousedown.prevent="selectSuggestion(cat)">
            {{ cat }}
          </div>
        </div>
      </div>
    </div>

    <div class="mt-5">
      <em>
        Updates about once every {{ feed.update_frequency }} day{{ feed.update_frequency === 1 ? '' : 's' }}.
      </em>
    </div>

    <section class="mt-6">
      <div class="is-flex is-align-items-start">
        <h2 class="title is-2 mr-auto">{{ showFinished ? 'All' : 'Unseen' }} {{ feed?.type === 'podcast' ? 'Episodes' : 'Posts' }}</h2>

        <span
            class="button icon py-4 mr-2 is-outlined"
            :class="{'is-primary': sortAscending, 'is-info': !sortAscending, 'is-loading': isFetching}"
            :title="sortAscending? 'Sort by latest items first' : 'Sort by earliest items first'"
            @click="sortAscending = !sortAscending">
          <span class="material-symbols-outlined">swap_vert</span>
        </span>
        <span
            class="button icon py-4 mr-2 is-outlined"
            :class="{'is-primary': showFinished, 'is-info': !showFinished, 'is-loading': isFetching}"
            :title="showFinished ? 'Hide finished items' : 'Show finished items'"
            @click="showFinished = !showFinished">
          <span class="material-symbols-outlined">{{ showFinished ? 'check_circle' : 'done' }}</span>
        </span>
        <div class="dropdown is-right" :class="{'is-active': menuOpen}">
          <div class="dropdown-trigger">
            <span
                class="button icon py-4 is-outlined is-info"
                :class="{'is-loading': menuLoading}"
                title="Feed actions"
                @click="menuOpen = !menuOpen">
              <span class="material-symbols-outlined">more_horiz</span>
            </span>
          </div>
          <div class="dropdown-menu" role="menu">
            <div class="dropdown-content">
              <a class="dropdown-item" @click="handleRefreshFeed">
                <span class="material-symbols-outlined mr-2" style="vertical-align: middle; font-size: 1.2em;">refresh</span>
                Refresh Feed
              </a>
              <a v-if="!feed?.has_archives" class="dropdown-item" @click="handleFetchArchives">
                <span class="material-symbols-outlined mr-2" style="vertical-align: middle; font-size: 1.2em;">archive</span>
                Fetch Archives
              </a>
            </div>
          </div>
        </div>
        <div v-if="menuOpen" class="menu-backdrop" @click="closeMenu"></div>
      </div>


      <ItemPreview
          v-for="feedItem in feedItems" :key="feedItem.guid"
          :feed-item="feedItem"
          class="mb-6"/>
      <div v-if="!hasMore && !isFetching && feedItems.length === 0">
        {{ showFinished
            ? `This feed doesn't have any ${feed?.type === 'podcast' ? 'episodes' : 'posts'} yet.`
            : `No unseen ${feed?.type === 'podcast' ? 'episodes' : 'posts'}. You're all caught up!` }}
      </div>
      <div v-if="hasMore" ref="loadMoreSentinel" class="has-text-centered py-4">
        <span v-if="isFetching" class="has-text-grey">Loading...</span>
      </div>
    </section>
    </template>
    <h1 v-else class="title is-1">Loading subscription...</h1>
  </div>
</template>

<style scoped>
.category-input-wrapper {
  position: relative;
}

.category-suggestions {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 10;
  background: hsl(var(--bulma-scheme-h), var(--bulma-scheme-s), var(--bulma-scheme-main-bis-l));
  color: hsl(var(--bulma-text-h), var(--bulma-text-s), var(--bulma-text-l));
  border: 1px solid hsl(var(--bulma-border-h), var(--bulma-border-s), var(--bulma-border-l));
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  max-height: 12rem;
  overflow-y: auto;
  min-width: 100%;
}

.category-suggestion {
  padding: 0.35rem 0.75rem;
  cursor: pointer;
  font-size: 0.85rem;
}

.category-suggestion:hover,
.category-suggestion.is-active {
  background: hsl(var(--bulma-scheme-h), var(--bulma-scheme-s), var(--bulma-background-l));
}

.menu-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
}
</style>