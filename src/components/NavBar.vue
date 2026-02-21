<script setup lang="ts">
import {ref, computed, nextTick, watch} from "vue";
import {useRouter} from "vue-router";
import {refDebounced, onKeyStroke, useIntersectionObserver} from "@vueuse/core";
import client from "../client.ts";
import type {FeedItemPreview} from "../types.ts";
import {useLatestAsync} from "../composables/useLatestAsync.ts";

const router = useRouter()
const sidebarOpen = defineModel<boolean>('sidebarOpen', {default: false})

const showSearch = ref(false)
const searchInput = ref('')
const searchInputEl = ref<HTMLInputElement>()
const commandStatus = ref<'idle' | 'running' | 'success' | 'error'>('idle')

const PAGE_SIZE = 20

const searchResults = ref<FeedItemPreview[]>([])
const searchOffset = ref(0)
const searchHasMore = ref(false)
const searchResultsEl = ref<HTMLElement>()
const searchSentinel = ref<HTMLElement>()

const {execute: search, isLoading: searchLoading} = useLatestAsync(
    (query: string, offset: number) => client.searchFeedItems(query, {limit: PAGE_SIZE, offset})
)

const debouncedInput = refDebounced(searchInput, 300)

const isCommand = computed(() => searchInput.value.startsWith('/'))
const placeholder = computed(() => isCommand.value ? 'Enter command...' : 'Search posts and podcasts...')

const commands = [
    {name: 'refresh all', description: 'Refresh all feed subscriptions'},
]

const commandQuery = computed(() => isCommand.value ? searchInput.value.slice(1).trim().toLowerCase() : '')
const matchingCommands = computed(() => {
    if (!isCommand.value) return []
    if (!commandQuery.value) return commands
    return commands.filter(c => c.name.includes(commandQuery.value))
})

const selectedIndex = ref(-1)
const listLength = computed(() =>
    isCommand.value ? matchingCommands.value.length : searchResults.value.length
)

// Reset selection and clear results immediately when input is too short
watch(searchInput, (newVal) => {
    selectedIndex.value = -1
    if (isCommand.value || newVal.trim().length < 3) {
        searchResults.value = []
        searchOffset.value = 0
        searchHasMore.value = false
    }
})

// Trigger search after debounce settles
watch(debouncedInput, async (newVal) => {
    if (isCommand.value) return
    const query = newVal.trim()
    if (query.length < 3) return

    const results = await search(query, 0)
    if (results !== null) {
        searchResults.value = results
        searchOffset.value = results.length
        searchHasMore.value = results.length === PAGE_SIZE
    }
})

async function loadMoreResults() {
    if (!searchHasMore.value || searchLoading.value) return
    const query = searchInput.value.trim()
    if (query.length < 3) return

    const results = await search(query, searchOffset.value)
    if (results !== null) {
        searchResults.value = [...searchResults.value, ...results]
        searchOffset.value += results.length
        if (results.length < PAGE_SIZE) searchHasMore.value = false
    }
}

useIntersectionObserver(searchSentinel, ([entry]) => {
    if (entry.isIntersecting) loadMoreResults()
}, {root: searchResultsEl})

function filterKeyEvent(e: KeyboardEvent) {
    if (showSearch.value) return false
    const tag = (e.target as HTMLElement).tagName
    return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT'
}

onKeyStroke('/', (e) => {
    if (!filterKeyEvent(e)) return
    e.preventDefault()
    openSearch('/')
})

onKeyStroke('?', (e) => {
    if (!filterKeyEvent(e)) return
    e.preventDefault()
    openSearch()
})

function handleInputKeydown(e: KeyboardEvent) {
    if (!listLength.value) return

    if (e.key === 'ArrowDown') {
        e.preventDefault()
        selectedIndex.value = Math.min(selectedIndex.value + 1, listLength.value - 1)
    } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        selectedIndex.value = Math.max(selectedIndex.value - 1, -1)
    }
}

function selectCommand(index: number) {
    const cmd = matchingCommands.value[index]
    if (cmd) {
        searchInput.value = '/' + cmd.name
        handleSubmit()
    }
}

function selectResult(result: FeedItemPreview) {
    router.push({name: 'item', params: {guid: result.guid}})
    closeSearch()
}

async function handleSubmit() {
    if (isCommand.value) {
        if (selectedIndex.value >= 0) {
            const cmd = matchingCommands.value[selectedIndex.value]
            if (cmd) {
                await executeCommand(cmd.name)
                return
            }
        }
        await executeCommand(searchInput.value.slice(1).trim())
    } else if (selectedIndex.value >= 0 && searchResults.value[selectedIndex.value]) {
        selectResult(searchResults.value[selectedIndex.value])
    }
}

async function executeCommand(command: string) {
    const [cmd, ...args] = command.toLowerCase().split(/\s+/)

    if (cmd === 'refresh' && args[0] === 'all') {
        commandStatus.value = 'running'
        try {
            const response = await fetch('/api/command/refresh-all-feeds', {method: 'POST'})
            if (response.ok) {
                const data = await response.json()
                commandStatus.value = 'success'
                console.log(`Refreshed ${data.refreshedCount} feeds`)
            } else {
                commandStatus.value = 'error'
            }
        } catch {
            commandStatus.value = 'error'
        }
        closeSearch()
    } else {
        console.log('Unknown command:', command)
    }
}

function openSearch(initialText: string = '') {
    showSearch.value = true
    searchInput.value = initialText
    commandStatus.value = 'idle'
    searchResults.value = []
    nextTick(() => searchInputEl.value?.focus())
}

function closeSearch() {
    showSearch.value = false
    searchInput.value = ''
    searchResults.value = []
}

function clearInput() {
    searchInput.value = ''
    searchInputEl.value?.focus()
}

function formatDate(dateStr: string | null): string {
    if (!dateStr) return ''
    return new Date(dateStr).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'})
}

function stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlightQuery(text: string, query: string): string {
    const escaped = escapeHtml(text)
    if (!query) return escaped
    const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return escaped.replace(new RegExp(pattern, 'gi'), '<mark>$&</mark>')
}

function makeSnippet(result: FeedItemPreview, query: string): string {
    const text = result.description ? stripHtml(result.description) : ''
    if (!text) return ''

    const lowerText = text.toLowerCase()
    const lowerQuery = query.toLowerCase()
    const pos = lowerText.indexOf(lowerQuery)

    let start: number, end: number
    if (pos === -1) {
        start = 0
        end = Math.min(text.length, 160)
    } else {
        start = Math.max(0, pos - 60)
        end = Math.min(text.length, pos + lowerQuery.length + 100)
    }

    let snippet = text.slice(start, end)
    if (start > 0) snippet = '...' + snippet
    if (end < text.length) snippet += '...'

    return highlightQuery(snippet, query)
}
</script>

<template>
  <nav class="navbar" role="navigation" aria-label="main navigation">
    <div class="navbar-brand">
      <router-link class="navbar-item" :to="{name: 'home'}">
        <img class="mr-2" src="/logo.svg" height="28" alt="logo">
        <span class="title is-4">Iris Aggregator</span>
      </router-link>
      <a
          role="button"
          class="navbar-burger is-hidden-tablet"
          :class="{'is-active': sidebarOpen}"
          aria-label="menu"
          :aria-expanded="sidebarOpen"
          @click="sidebarOpen = !sidebarOpen">
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
      </a>
    </div>

    <div class="navbar-menu">
      <div class="navbar-end">
        <div class="navbar-item">
          <input class="input" type="search" placeholder="Search posts and podcasts" readonly @click="openSearch()">
        </div>
      </div>
    </div>

    <div class="modal" :class="{'is-active': showSearch}">
      <div class="modal-background is-transparent" @click="closeSearch"/>
      <div class="modal-card">
        <section class="modal-card-body">
          <div class="field">
            <div class="control has-icons-right">
              <input
                  ref="searchInputEl"
                  class="input is-large"
                  type="text"
                  v-model="searchInput"
                  :placeholder="placeholder"
                  @keydown="handleInputKeydown"
                  @keyup.enter="handleSubmit"
                  @keyup.esc="closeSearch">
              <span
                  v-if="searchInput.length"
                  class="icon is-right is-large is-clickable"
                  @mousedown.prevent="clearInput">
                <span class="material-symbols-outlined">close</span>
              </span>
            </div>
            <p v-if="!isCommand" class="help">
              <template v-if="searchInput.trim().length === 0">Type "/" to enter a command</template>
              <template v-else-if="searchInput.trim().length < 3">Type at least 3 characters to search</template>
            </p>

            <div v-if="matchingCommands.length" class="command-list mt-2">
              <div
                  v-for="(cmd, i) in matchingCommands"
                  :key="cmd.name"
                  class="command-item px-3 py-2"
                  :class="{'is-selected': i === selectedIndex}"
                  @click="selectCommand(i)">
                <span class="has-text-weight-medium">/{{ cmd.name }}</span>
                <span class="has-text-grey ml-2">{{ cmd.description }}</span>
              </div>
            </div>

            <div v-if="!isCommand && (searchResults.length || searchLoading)" ref="searchResultsEl" class="search-results mt-2">
              <div v-if="searchLoading && !searchResults.length" class="px-3 py-2 has-text-grey">
                Searching...
              </div>
              <div
                  v-for="(result, i) in searchResults"
                  :key="result.guid"
                  class="search-result px-3 py-2"
                  :class="{'is-selected': i === selectedIndex}"
                  @click="selectResult(result)">
                <div class="is-flex is-justify-content-space-between is-align-items-baseline">
                  <span class="has-text-weight-medium search-result-title" v-html="highlightQuery(result.title, searchInput.trim())"></span>
                  <span class="has-text-grey is-size-7 ml-2 is-flex-shrink-0">{{ formatDate(result.date) }}</span>
                </div>
                <div
                    class="search-result-snippet is-size-7 has-text-grey-dark mt-1"
                    v-html="makeSnippet(result, searchInput.trim())">
                </div>
              </div>
              <div v-if="!searchLoading && !searchResults.length" class="px-3 py-2 has-text-grey">
                No results found
              </div>
              <div v-if="searchHasMore" ref="searchSentinel" class="px-3 py-2 has-text-grey has-text-centered is-size-7">
                <span v-if="searchLoading">Loading more...</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.command-list,
.search-results {
    border: 1px solid hsl(var(--bulma-border-h), var(--bulma-border-s), var(--bulma-border-l));
    border-radius: 4px;
}

.command-item,
.search-result {
    cursor: pointer;
}
.command-item:hover,
.command-item.is-selected,
.search-result:hover,
.search-result.is-selected {
    background: hsl(var(--bulma-scheme-h), var(--bulma-scheme-s), var(--bulma-scheme-main-ter-l));
}
.command-item + .command-item {
    border-top: 1px solid var(--bulma-border-weak);
}

.search-results {
    max-height: 420px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--bulma-border) transparent;
}
.search-results::-webkit-scrollbar {
    width: 6px;
}
.search-results::-webkit-scrollbar-track {
    background: transparent;
}
.search-results::-webkit-scrollbar-thumb {
    background: var(--bulma-border);
    border-radius: 3px;
}
.search-results::-webkit-scrollbar-thumb:hover {
    background: var(--bulma-border-hover);
}
.search-result {
    border-bottom: 1px solid var(--bulma-border-weak);
}
.search-result:last-child {
    border-bottom: none;
}
.search-result-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.search-result-snippet {
    line-height: 1.4;
}
.search-result :deep(mark) {
    background: color-mix(in srgb, var(--bulma-primary) 30%, transparent);
    border-radius: 2px;
    font-weight: 600;
    padding: 0 1px;
}
</style>
