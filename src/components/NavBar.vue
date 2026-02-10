<script setup lang="ts">
import {ref, computed, nextTick, watch, onMounted, onUnmounted} from "vue";

const showSearch = ref(false)
const searchInput = ref('')
const searchInputEl = ref<HTMLInputElement>()
const commandStatus = ref<'idle' | 'running' | 'success' | 'error'>('idle')

function handleKeydown(e: KeyboardEvent) {
    if (showSearch.value) return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    if (e.key === '/') {
        e.preventDefault()
        openSearch('/')
    } else if (e.key === '?') {
        e.preventDefault()
        openSearch()
    }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))

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

const selectedCommandIndex = ref(-1)
watch(searchInput, () => { selectedCommandIndex.value = -1 })

function handleInputKeydown(e: KeyboardEvent) {
    if (!matchingCommands.value.length) return

    if (e.key === 'ArrowDown') {
        e.preventDefault()
        selectedCommandIndex.value = Math.min(selectedCommandIndex.value + 1, matchingCommands.value.length - 1)
    } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        selectedCommandIndex.value = Math.max(selectedCommandIndex.value - 1, -1)
    }
}

function selectCommand(index: number) {
    const cmd = matchingCommands.value[index]
    if (cmd) {
        searchInput.value = '/' + cmd.name
        handleSubmit()
    }
}

async function handleSubmit() {
    if (isCommand.value) {
        if (selectedCommandIndex.value >= 0) {
            const cmd = matchingCommands.value[selectedCommandIndex.value]
            if (cmd) {
                await executeCommand(cmd.name)
                return
            }
        }
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

function openSearch(initialText: string = '') {
    showSearch.value = true
    searchInput.value = initialText
    commandStatus.value = 'idle'
    nextTick(() => searchInputEl.value?.focus())
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
                  ref="searchInputEl"
                  class="input is-large"
                  type="text"
                  v-model="searchInput"
                  :placeholder="placeholder"
                  @keydown="handleInputKeydown"
                  @keyup.enter="handleSubmit"
                  @keyup.esc="closeSearch">
            </div>
            <p v-if="!isCommand" class="help">Type "/" to enter a command</p>
            <div v-if="matchingCommands.length" class="command-list mt-2">
              <div
                  v-for="(cmd, i) in matchingCommands"
                  :key="cmd.name"
                  class="command-item px-3 py-2"
                  :class="{'is-selected': i === selectedCommandIndex}"
                  @click="selectCommand(i)">
                <span class="has-text-weight-medium">/{{ cmd.name }}</span>
                <span class="has-text-grey ml-2">{{ cmd.description }}</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.command-list {
    border: 1px solid hsl(0, 0%, 90%);
    border-radius: 4px;
}
.command-item {
    cursor: pointer;
}
.command-item:hover,
.command-item.is-selected {
    background-color: hsl(0, 0%, 96%);
}
.command-item + .command-item {
    border-top: 1px solid hsl(0, 0%, 95%);
}
</style>