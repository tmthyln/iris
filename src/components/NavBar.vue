<script setup lang="ts">
import {ref, computed} from "vue";

const showSearch = ref(false)
const searchInput = ref('')
const commandStatus = ref<'idle' | 'running' | 'success' | 'error'>('idle')

const isCommand = computed(() => searchInput.value.startsWith('/'))
const placeholder = computed(() => isCommand.value ? 'Enter command...' : 'Search posts and podcasts...')

async function handleSubmit() {
    if (isCommand.value) {
        await executeCommand(searchInput.value.slice(1).trim())
    } else {
        // TODO: handle search
        console.log('Search:', searchInput.value)
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

function openSearch() {
    showSearch.value = true
    searchInput.value = ''
    commandStatus.value = 'idle'
}

function closeSearch() {
    showSearch.value = false
    searchInput.value = ''
}
</script>

<template>
  <nav class="navbar" role="navigation" aria-label="main navigation">
    <div class="navbar-brand">
      <router-link class="navbar-item" :to="{name: 'home'}">
        <img class="mr-2" src="/logo.svg" height="28" alt="logo">
        <span class="title is-4">Iris Aggregator</span>
      </router-link>
    </div>

    <div class="navbar-menu">
      <div class="navbar-end">
        <div class="navbar-item">
          <input class="input" type="search" placeholder="Search posts and podcasts" readonly @click="openSearch">
        </div>
      </div>
    </div>

    <div class="modal" :class="{'is-active': showSearch}">
      <div class="modal-background is-transparent" @click="closeSearch"/>
      <div class="modal-card">
        <section class="modal-card-body">
          <div class="field">
            <div class="control">
              <input
                  class="input is-large"
                  type="text"
                  v-model="searchInput"
                  :placeholder="placeholder"
                  @keyup.enter="handleSubmit"
                  autofocus>
            </div>
            <p class="help">Type "/" to enter a command</p>
          </div>
        </section>
      </div>
    </div>
  </nav>
</template>

<style scoped>
</style>