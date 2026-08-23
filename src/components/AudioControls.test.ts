import {flushPromises, type VueWrapper} from '@vue/test-utils'
import {afterEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {useDownloadStore} from '../stores/downloads.ts'
import {useFeedStore} from '../stores/feeds.ts'
import {useQueueStore} from '../stores/queue.ts'
import {useTranscriptStore} from '../stores/transcripts.ts'
import {err, makeFeed, makeItem, makeTranscript, ok, stubClient, mountApp} from '../testing/helpers.ts'
import AudioControls from './AudioControls.vue'

afterEach(() => vi.restoreAllMocks())

/** Icon-only buttons render exactly their icon name as text. */
function button(wrapper: VueWrapper, icon: string) {
    const match = wrapper.findAll('button').find(b => b.text() === icon)
    expect(match, `button with icon ${icon}`).toBeDefined()
    return match!
}

function podcastSetup(itemOverrides = {}) {
    const feed = makeFeed({type: 'podcast'})
    const item = makeItem({source_feed: feed.guid, enclosure_url: 'https://example.com/a.mp3', ...itemOverrides})
    return {feed, item}
}

async function mountControls(feed: ReturnType<typeof makeFeed> | null, item: ReturnType<typeof makeItem>, props = {}) {
    const mounted = await mountApp(AudioControls, {props: {feedItem: item, ...props}})
    if (feed) {
        useFeedStore().feeds = [feed]
        await mounted.wrapper.vm.$nextTick()
    }
    return mounted
}

describe('per-feed-type buttons', () => {
    it('hides the playback buttons for blog feeds but keeps finished/bookmark', async () => {
        const feed = makeFeed({type: 'blog'})
        const item = makeItem({source_feed: feed.guid})
        const {wrapper} = await mountControls(feed, item)

        expect(wrapper.text()).not.toContain('Play')
        expect(wrapper.findAll('button')).toHaveLength(2)   // finished + bookmark
        button(wrapper, 'done')
        button(wrapper, 'bookmark_add')
    })

    it('shows play, queue and download buttons for podcast episodes', async () => {
        const {feed, item} = podcastSetup()
        const {wrapper} = await mountControls(feed, item)

        expect(wrapper.text()).toContain('Play')
        button(wrapper, 'playlist_add')
        button(wrapper, 'download')
    })
})

describe('playing', () => {
    it('starts playback of a new item at the front of the queue', async () => {
        const {feed, item} = podcastSetup()
        stubClient('queueFeedItem', ok([item]))
        const {wrapper} = await mountControls(feed, item)

        await wrapper.find('button.tag').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.queueFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, 0)
        expect(useQueueStore().paused).toBe(false)
    })

    it('toggles pause when the item is already playing', async () => {
        const {feed, item} = podcastSetup()
        const {wrapper} = await mountControls(feed, item)
        const queueStore = useQueueStore()
        queueStore.items = [item]
        queueStore.paused = true
        await wrapper.vm.$nextTick()

        expect(wrapper.find('button.tag').text()).toContain('Paused')
        await wrapper.find('button.tag').trigger('click')
        expect(queueStore.paused).toBe(false)
        expect(wrapper.find('button.tag').text()).toContain('Playing')
    })

    it('labels a queued (not playing) item and a finished item accordingly', async () => {
        const {feed, item} = podcastSetup()
        const {wrapper} = await mountControls(feed, item)
        const queueStore = useQueueStore()
        queueStore.items = [makeItem(), item]
        await wrapper.vm.$nextTick()
        expect(wrapper.find('button.tag').text()).toContain('Queued')

        queueStore.items = []
        item.finished = true
        await wrapper.vm.$nextTick()
        expect(wrapper.find('button.tag').text()).toContain('Play Again')
    })
})

describe('queueing', () => {
    it('adds the item to the end of the queue', async () => {
        const {feed, item} = podcastSetup()
        stubClient('queueFeedItem', ok([item]))
        const {wrapper} = await mountControls(feed, item)

        await button(wrapper, 'playlist_add').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.queueFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, undefined)
    })

    it('removes a queued item from the queue', async () => {
        const {feed, item} = podcastSetup()
        stubClient('removeQueueItem', ok([]))
        const {wrapper} = await mountControls(feed, item)
        useQueueStore().items = [makeItem(), item]
        await wrapper.vm.$nextTick()

        await button(wrapper, 'playlist_add_check').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.removeQueueItem)).toHaveBeenCalledExactlyOnceWith(item.guid)
    })
})

describe('finished and bookmarked', () => {
    it('marks an unfinished item as complete', async () => {
        const {feed, item} = podcastSetup()
        stubClient('modifyFeedItem', ok(undefined))
        const {wrapper} = await mountControls(feed, item)

        await button(wrapper, 'done').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {finished: true})
        expect(item.finished).toBe(true)
        button(wrapper, 'check_circle')   // icon flipped
    })

    it('marks a finished item as incomplete', async () => {
        const {feed, item} = podcastSetup({finished: true})
        stubClient('modifyFeedItem', ok(undefined))
        const {wrapper} = await mountControls(feed, item)

        await button(wrapper, 'check_circle').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {finished: false})
    })

    it('toggles the bookmark', async () => {
        const {feed, item} = podcastSetup()
        stubClient('modifyFeedItem', ok(undefined))
        const {wrapper} = await mountControls(feed, item)

        await button(wrapper, 'bookmark_add').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {bookmarked: true})
        button(wrapper, 'bookmark_added')
    })
})

describe('downloading', () => {
    it('starts a download from the idle state', async () => {
        const {feed, item} = podcastSetup()
        const {wrapper} = await mountControls(feed, item)
        const download = vi.spyOn(useDownloadStore(), 'downloadItem').mockResolvedValue()

        await button(wrapper, 'download').trigger('click')
        expect(download).toHaveBeenCalledExactlyOnceWith(item)
    })

    it('shows progress while downloading and an error state on failure', async () => {
        const {feed, item} = podcastSetup()
        const {wrapper} = await mountControls(feed, item)
        const downloadStore = useDownloadStore()

        downloadStore.statuses[item.guid] = {state: 'downloading', progress: 0.42, abortController: new AbortController()}
        await wrapper.vm.$nextTick()
        expect(wrapper.find('[title="Downloading: 42%"]').exists()).toBe(true)

        downloadStore.statuses[item.guid] = {state: 'error', message: 'HTTP 502'}
        await wrapper.vm.$nextTick()
        expect(wrapper.find('[title="Download failed: HTTP 502. Click to retry"]').exists()).toBe(true)
    })

    it('deletes a completed download', async () => {
        const {feed, item} = podcastSetup()
        const {wrapper} = await mountControls(feed, item)
        const downloadStore = useDownloadStore()
        downloadStore.statuses[item.guid] = {state: 'downloaded', size: 1000, downloadedAt: '2024-01-01T00:00:00Z'}
        const remove = vi.spyOn(downloadStore, 'deleteDownload').mockResolvedValue()
        await wrapper.vm.$nextTick()

        await button(wrapper, 'download_done').trigger('click')
        expect(remove).toHaveBeenCalledExactlyOnceWith(item.guid)
    })
})

describe('transcripts (opt-in via showTranscript)', () => {
    it('fetches transcript state on mount for podcast episodes', async () => {
        const {feed, item} = podcastSetup()
        const listSpy = stubClient('listTranscripts', ok([]))
        await mountControls(feed, item, {showTranscript: true})
        await flushPromises()
        expect(listSpy).toHaveBeenCalledExactlyOnceWith(item.guid)
    })

    it('requests a transcript when none exists', async () => {
        const {feed, item} = podcastSetup()
        stubClient('listTranscripts', ok([]))
        stubClient('requestTranscript', err(500, 'nope'))
        const {wrapper} = await mountControls(feed, item, {showTranscript: true})
        await flushPromises()

        await button(wrapper, 'description').trigger('click')
        expect(vi.mocked(client.requestTranscript)).toHaveBeenCalledExactlyOnceWith(item.guid, {})
    })

    it('opens a completed transcript instead of re-requesting', async () => {
        const {feed, item} = podcastSetup()
        const complete = makeTranscript({feed_item_guid: item.guid, status: 'complete'})
        stubClient('listTranscripts', ok([complete]))
        const {wrapper} = await mountControls(feed, item, {showTranscript: true})
        await flushPromises()

        await button(wrapper, 'description').trigger('click')
        expect(wrapper.emitted('open-transcript')).toHaveLength(1)
    })

    it('shows progress while transcribing', async () => {
        const {feed, item} = podcastSetup()
        stubClient('listTranscripts', ok([makeTranscript({feed_item_guid: item.guid, status: 'processing'})]))
        vi.useFakeTimers()   // keep the store's poller off the real clock
        const {wrapper} = await mountControls(feed, item, {showTranscript: true})
        await vi.advanceTimersByTimeAsync(0)
        expect(button(wrapper, 'graphic_eq').find('[title="Transcribing audio…"]').exists()).toBe(true)
        useTranscriptStore().byItem[item.guid] = []   // stop state, then drop the poller with real timers
        vi.useRealTimers()
    })

    it('offers a retry when transcription failed', async () => {
        const {feed, item} = podcastSetup()
        const failed = makeTranscript({feed_item_guid: item.guid, status: 'error', error_message: 'GPU on fire'})
        stubClient('listTranscripts', ok([failed]))
        stubClient('requestTranscript', ok(makeTranscript({status: 'pending'}), 201))
        const {wrapper} = await mountControls(feed, item, {showTranscript: true})
        await flushPromises()

        const retry = wrapper.find('[title="Transcription failed: GPU on fire. Click to retry"]')
        expect(retry.exists()).toBe(true)
        await retry.trigger('click')
        expect(vi.mocked(client.requestTranscript)).toHaveBeenCalledExactlyOnceWith(item.guid, {})
    })
})
