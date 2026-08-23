import {flushPromises} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {useDownloadStore} from '../stores/downloads.ts'
import {useQueueStore} from '../stores/queue.ts'
import {makeItem, ok, stubClient, mountApp} from '../testing/helpers.ts'
import AudioPlayer from './AudioPlayer.vue'

// jsdom's media element implements none of the playback machinery.
beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

function episode(overrides = {}) {
    return makeItem({enclosure_url: 'https://cdn.example.com/episode.mp3', ...overrides})
}

/** Seed the queue before mounting, since the whole player is v-if'd on it. */
async function mountPlayer(items: ReturnType<typeof makeItem>[], seed?: (pinia: ReturnType<typeof createPinia>) => void) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const queueStore = useQueueStore()
    queueStore.items = items
    seed?.(pinia)
    const mounted = await mountApp(AudioPlayer, {}, {pinia})
    await flushPromises()
    return {...mounted, queueStore}
}

/** Report metadata for the <audio> element the way a real browser would. */
async function loadMetadata(wrapper: {find: (selector: string) => {element: Element}}, duration: number) {
    const audio = wrapper.find('audio').element as HTMLAudioElement
    Object.defineProperty(audio, 'duration', {configurable: true, value: duration})
    audio.dispatchEvent(new Event('durationchange'))
    await flushPromises()
    return audio
}

describe('visibility', () => {
    it('renders nothing while the queue is empty', async () => {
        const {wrapper} = await mountPlayer([])
        expect(wrapper.find('footer').exists()).toBe(false)
    })

    it('shows the current item title and a loading play button before metadata arrives', async () => {
        const item = episode({title: 'Episode One'})
        const {wrapper} = await mountPlayer([item])
        expect(wrapper.find('.player-left').text()).toBe('Episode One')
        expect(wrapper.find('[title="Loading..."]').exists()).toBe(true)
    })
})

describe('playback controls', () => {
    it('enables the controls once the duration is known', async () => {
        const {wrapper} = await mountPlayer([episode()])
        await loadMetadata(wrapper, 300)
        expect(wrapper.find('[title="Play"]').exists()).toBe(true)
        expect(wrapper.find('.player-right').text()).toContain('0:00 / 5:00')
    })

    it('resumes from the item progress when metadata loads', async () => {
        const {wrapper} = await mountPlayer([episode({progress: 0.5})])
        const audio = await loadMetadata(wrapper, 200)
        expect(audio.currentTime).toBe(100)
    })

    it('seeks with the rewind and fast-forward buttons', async () => {
        const {wrapper} = await mountPlayer([episode()])
        const audio = await loadMetadata(wrapper, 300)
        audio.currentTime = 50
        audio.dispatchEvent(new Event('timeupdate'))
        await flushPromises()

        await wrapper.find('[title="Skip forward 30 seconds"]').trigger('click')
        expect(audio.currentTime).toBe(80)
        await wrapper.find('[title="Rewind 10 seconds"]').trigger('click')
        expect(audio.currentTime).toBe(70)
    })

    it('cycles the playback rate', async () => {
        const {wrapper} = await mountPlayer([episode()])
        await loadMetadata(wrapper, 300)
        const rateButton = wrapper.find('button.tag')
        expect(rateButton.text()).toBe('1x')
        await rateButton.trigger('click')
        expect(rateButton.text()).toBe('1.25x')
    })

    it('applies a seek requested from outside (transcript timestamps)', async () => {
        stubClient('modifyFeedItem', ok(undefined))
        const item = episode()
        const {wrapper, queueStore} = await mountPlayer([item])
        const audio = await loadMetadata(wrapper, 300)

        queueStore.requestSeek(120)
        await flushPromises()
        expect(audio.currentTime).toBe(120)
        expect(queueStore.pendingSeek).toBeNull()
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {progress: 0.4})
    })

    it('saves progress and moves on when an episode ends', async () => {
        stubClient('modifyFeedItem', ok(undefined))
        stubClient('removeQueueItem', ok([]))
        const item = episode()
        const {wrapper} = await mountPlayer([item])
        const audio = await loadMetadata(wrapper, 300)

        Object.defineProperty(audio, 'ended', {configurable: true, value: true})
        audio.dispatchEvent(new Event('ended'))
        await flushPromises()

        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledWith(item.guid, {finished: true, progress: 1})
        expect(vi.mocked(client.removeQueueItem)).toHaveBeenCalledExactlyOnceWith(item.guid)
    })

    it('skips to the next episode, saving progress first', async () => {
        stubClient('modifyFeedItem', ok(undefined))
        const [current, next] = [episode(), episode()]
        stubClient('removeQueueItem', ok([next]))
        const {wrapper} = await mountPlayer([current, next])
        const audio = await loadMetadata(wrapper, 300)
        audio.currentTime = 150
        audio.dispatchEvent(new Event('timeupdate'))
        await flushPromises()

        await wrapper.find('[title="Skip to next in queue"]').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledWith(current.guid, {progress: 0.5})
        expect(vi.mocked(client.removeQueueItem)).toHaveBeenCalledExactlyOnceWith(current.guid)
    })
})

describe('audio source', () => {
    // useMediaControls applies `src` by appending <source> children.
    function sourceOf(wrapper: {find: (selector: string) => {element: Element}}) {
        return wrapper.find('audio').element.querySelector('source')?.src
    }

    it('streams from the enclosure URL by default', async () => {
        const item = episode()
        const {wrapper} = await mountPlayer([item])
        expect(sourceOf(wrapper)).toBe(item.enclosure_url)
    })

    it('prefers the downloaded copy when one exists', async () => {
        const item = episode()
        const {wrapper} = await mountPlayer([item], () => {
            const downloadStore = useDownloadStore()
            downloadStore.statuses[item.guid] = {state: 'downloaded', size: 1, downloadedAt: '2024-01-01T00:00:00Z'}
            vi.spyOn(downloadStore, 'getLocalUrl').mockResolvedValue('blob:local-copy')
        })
        await flushPromises()
        expect(sourceOf(wrapper)).toBe('blob:local-copy')
    })
})

describe('pause bookkeeping', () => {
    it('saves the playback position when pausing', async () => {
        stubClient('modifyFeedItem', ok(undefined))
        const item = episode()
        const {wrapper, queueStore} = await mountPlayer([item])
        const audio = await loadMetadata(wrapper, 300)
        audio.currentTime = 90
        audio.dispatchEvent(new Event('timeupdate'))
        await flushPromises()

        await wrapper.find('[title="Play"]').trigger('click')
        expect(queueStore.paused).toBe(false)
        await wrapper.find('[title="Pause"]').trigger('click')
        await flushPromises()
        expect(queueStore.paused).toBe(true)
        expect(vi.mocked(client.modifyFeedItem)).toHaveBeenCalledExactlyOnceWith(item.guid, {progress: 0.3})
    })
})

describe('queue popover', () => {
    it('lists the upcoming items with play-now and remove controls', async () => {
        stubClient('removeQueueItem', ok([]))
        const [current, upNext] = [episode(), episode({title: 'Up Next Episode'})]
        const {wrapper} = await mountPlayer([current, upNext])

        await wrapper.find('.queue-toggle-button').trigger('click')
        expect(wrapper.find('.queue-item').text()).toContain('Up Next Episode')

        await wrapper.find('.queue-item [title="Remove from queue"]').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.removeQueueItem)).toHaveBeenCalledExactlyOnceWith(upNext.guid)
    })

    it('promotes an upcoming item with play now', async () => {
        const [current, upNext] = [episode(), episode()]
        stubClient('removeQueueItem', ok([current]))
        stubClient('queueFeedItem', ok([upNext, current]))
        const {wrapper, queueStore} = await mountPlayer([current, upNext])

        await wrapper.find('.queue-toggle-button').trigger('click')
        await wrapper.find('.queue-item [title="Play now"]').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.queueFeedItem)).toHaveBeenCalledExactlyOnceWith(upNext.guid, 0)
        expect(queueStore.currentlyPlaying?.guid).toBe(upNext.guid)
    })

    it('clears the queue, keeping the current item only while playing', async () => {
        stubClient('clearQueue', ok([]))
        const {wrapper, queueStore} = await mountPlayer([episode(), episode()])
        expect(queueStore.paused).toBe(true)

        await wrapper.find('.queue-toggle-button').trigger('click')
        await wrapper.find('[title="Clear queue"]').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.clearQueue)).toHaveBeenCalledExactlyOnceWith(false)   // paused → drop everything
    })
})
