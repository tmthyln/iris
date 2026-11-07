import {flushPromises} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import client from '../client.ts'
import {useDownloadStore} from '../stores/downloads.ts'
import {useQueueStore} from '../stores/queue.ts'
import {makeItem, ok, stubClient, mountApp} from '../testing/helpers.ts'
import {flush} from '../telemetry.ts'
import type {ClientLogEvent} from '../types.ts'
import AudioPlayer from './AudioPlayer.vue'

// jsdom's media element implements none of the playback machinery.
beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
    // Nor does its <dialog> have showModal.
    HTMLDialogElement.prototype.showModal = vi.fn()
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

    it('starts a newly loaded episode from a requested position, over its saved progress', async () => {
        const item = episode({progress: 0.5})
        const {wrapper, queueStore} = await mountPlayer([item])
        queueStore.pendingStart = {guid: item.guid, seconds: 42}
        await loadMetadata(wrapper, 300)

        expect(wrapper.find<HTMLAudioElement>('audio').element.currentTime).toBe(42)
        expect(queueStore.pendingStart).toBeNull()
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

    it('keeps playing the same source when its download finishes mid-episode', async () => {
        const item = episode()
        const {wrapper} = await mountPlayer([item])
        const audio = await loadMetadata(wrapper, 300)
        audio.currentTime = 120
        const source = () => wrapper.find('source').attributes('src')
        expect(source()).toBe(item.enclosure_url)

        const downloadStore = useDownloadStore()
        const getLocalUrl = vi.spyOn(downloadStore, 'getLocalUrl').mockResolvedValue('blob:local-copy')
        downloadStore.statuses[item.guid] = {state: 'downloaded', size: 1, downloadedAt: '2024-01-01T00:00:00Z'}
        await flushPromises()

        expect(getLocalUrl).not.toHaveBeenCalled()
        expect(source()).toBe(item.enclosure_url)
    })

    it('still switches to a download that finishes before playback starts', async () => {
        const item = episode()
        const {wrapper} = await mountPlayer([item])
        const downloadStore = useDownloadStore()
        vi.spyOn(downloadStore, 'getLocalUrl').mockResolvedValue('blob:local-copy')
        downloadStore.statuses[item.guid] = {state: 'downloaded', size: 1, downloadedAt: '2024-01-01T00:00:00Z'}
        await flushPromises()

        expect(wrapper.find('source').attributes('src')).toBe('blob:local-copy')
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

    describe('with pinned audio', () => {
        const downloaded = (guid: string, pinnedCopy: boolean) => () => {
            const downloadStore = useDownloadStore()
            downloadStore.statuses[guid] = {state: 'downloaded', size: 1, downloadedAt: '2024-01-01T00:00:00Z'}
            if (pinnedCopy) downloadStore.downloadedItems[guid] = episode({guid, pinned_audio: true})
            vi.spyOn(downloadStore, 'getLocalUrl').mockResolvedValue('blob:local-copy')
        }

        afterEach(() => vi.unstubAllGlobals())

        it('streams it through the Worker', async () => {
            const item = episode({guid: 'a/b', pinned_audio: true})
            const {wrapper} = await mountPlayer([item])
            expect(wrapper.find('source').attributes('src')).toBe('/api/feeditem/a%2Fb/media')
        })

        it('prefers it over a download of an earlier copy', async () => {
            const item = episode({pinned_audio: true})
            const {wrapper} = await mountPlayer([item], downloaded(item.guid, false))
            await flushPromises()
            expect(wrapper.find('source').attributes('src')).toBe(`/api/feeditem/${item.guid}/media`)
        })

        it('falls back to a download of an earlier copy when offline', async () => {
            vi.stubGlobal('navigator', Object.create(navigator, {onLine: {value: false}}) as Navigator)
            const item = episode({pinned_audio: true})
            const {wrapper} = await mountPlayer([item], downloaded(item.guid, false))
            await flushPromises()
            expect(sourceOf(wrapper)).toBe('blob:local-copy')
        })

        it('plays a download of the pinned copy', async () => {
            const item = episode({pinned_audio: true})
            const {wrapper} = await mountPlayer([item], downloaded(item.guid, true))
            await flushPromises()
            expect(sourceOf(wrapper)).toBe('blob:local-copy')
        })

        it('keeps the source when the audio is pinned mid-episode', async () => {
            const item = episode()
            const {wrapper, queueStore} = await mountPlayer([item])
            const audio = await loadMetadata(wrapper, 300)
            audio.currentTime = 120

            queueStore.markAudioPinned(item.guid)
            await flushPromises()

            expect(wrapper.find('source').attributes('src')).toBe(item.enclosure_url)
        })

        it('switches when the audio is pinned before playback starts', async () => {
            const item = episode()
            const {wrapper, queueStore} = await mountPlayer([item])

            queueStore.markAudioPinned(item.guid)
            await flushPromises()

            expect(wrapper.find('source').attributes('src')).toBe(`/api/feeditem/${item.guid}/media`)
        })
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
    it('has no toggle when nothing is queued after the current episode', async () => {
        const {wrapper} = await mountPlayer([episode()])
        expect(wrapper.find('.queue-toggle-button').exists()).toBe(false)
    })

    it('closes when the last queued episode is removed', async () => {
        const [current, upNext] = [episode(), episode()]
        stubClient('removeQueueItem', ok([current]))
        const {wrapper} = await mountPlayer([current, upNext])

        await wrapper.find('.queue-toggle-button').trigger('click')
        await wrapper.find('.queue-item [title="Remove from queue"]').trigger('click')
        await flushPromises()
        expect(wrapper.find('.queue-popover').exists()).toBe(false)
        expect(wrapper.find('.queue-toggle-button').exists()).toBe(false)
    })

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

describe('full player', () => {
    async function openFullPlayer(items: ReturnType<typeof makeItem>[], route = '/') {
        const mounted = await mountPlayer(items)
        await mounted.router.push(route)
        await mounted.wrapper.find('.player-layout [title="Open full player"]').trigger('click')
        await flushPromises()
        return mounted
    }

    it('stays closed until asked for', async () => {
        const {wrapper} = await mountPlayer([episode()])
        expect(wrapper.find('dialog').exists()).toBe(false)
    })

    it('opens as a modal on the same page, with its own history entry', async () => {
        const mounted = await openFullPlayer([episode({title: 'Episode One'})], '/downloads?x=1')
        expect(mounted.router.currentRoute.value.fullPath).toBe('/downloads?x=1#player')
        expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce()
        expect(mounted.wrapper.find('dialog .episode-title').text()).toBe('Episode One')
    })

    it('closes back to the page it was opened from', async () => {
        const mounted = await openFullPlayer([episode()], '/downloads')
        await mounted.wrapper.find('dialog [title="Close full player"]').trigger('click')
        await flushPromises()
        expect(mounted.router.currentRoute.value.fullPath).toBe('/downloads')
        expect(mounted.wrapper.find('dialog').exists()).toBe(false)
    })

    it('closes when the browser closes the dialog (Escape, Android back)', async () => {
        const mounted = await openFullPlayer([episode()], '/downloads')
        await mounted.wrapper.find('dialog').trigger('close')
        await flushPromises()
        expect(mounted.router.currentRoute.value.hash).toBe('')
    })

    it('controls the same playback as the bottom player', async () => {
        const mounted = await openFullPlayer([episode()])
        const audio = await loadMetadata(mounted.wrapper, 300)
        audio.currentTime = 50
        audio.dispatchEvent(new Event('timeupdate'))
        await flushPromises()
        const dialog = mounted.wrapper.find('dialog')

        expect(dialog.find('.times').text()).toContain('0:50')
        expect(dialog.find('.times').text()).toContain('-4:10')
        await dialog.find('[title="Skip forward 30 seconds"]').trigger('click')
        expect(audio.currentTime).toBe(80)
        await dialog.find('[title="Rewind 10 seconds"]').trigger('click')
        expect(audio.currentTime).toBe(70)
        await dialog.find('[title="Play"]').trigger('click')
        expect(mounted.queueStore.paused).toBe(false)
        await dialog.find('[title="Change playback speed"]').trigger('click')
        expect(dialog.find('[title="Change playback speed"]').text()).toBe('1.25x')
    })

    it('seeks when a drag of the slider ends, not during it', async () => {
        const modifyFeedItem = stubClient('modifyFeedItem', ok(undefined))
        const mounted = await openFullPlayer([episode()])
        const audio = await loadMetadata(mounted.wrapper, 300)
        const slider = mounted.wrapper.find<HTMLInputElement>('dialog input[type="range"]')

        slider.element.value = '150'
        await slider.trigger('input')
        expect(audio.currentTime).toBe(0)
        expect(modifyFeedItem).not.toHaveBeenCalled()
        expect(mounted.wrapper.find('dialog .times').text()).toContain('2:30')

        await slider.trigger('change')
        expect(audio.currentTime).toBe(150)
        expect(modifyFeedItem).toHaveBeenCalledOnce()
    })

    it('shows what is next and offers the queue controls', async () => {
        stubClient('removeQueueItem', ok([]))
        const [current, upNext, later] = [episode(), episode({title: 'Next &amp; Best'}), episode()]
        const mounted = await openFullPlayer([current, upNext, later])
        const toggle = mounted.wrapper.find('dialog .queue-toggle')
        expect(toggle.text()).toContain('Up next: Next & Best')
        expect(toggle.text()).toContain('2')

        await toggle.trigger('click')
        expect(mounted.wrapper.find('dialog').classes()).toContain('is-queue-shown')
        await mounted.wrapper.find('dialog .queue-item [title="Remove from queue"]').trigger('click')
        await flushPromises()
        expect(vi.mocked(client.removeQueueItem)).toHaveBeenCalledExactlyOnceWith(upNext.guid)
    })

    it('closes when the top of the screen is dragged far enough down', async () => {
        const mounted = await openFullPlayer([episode()], '/downloads')
        const artwork = mounted.wrapper.find('dialog .artwork')
        const dragTo = (clientY: number) => artwork.trigger('touchmove', {touches: [{clientY}]})

        await artwork.trigger('touchstart', {touches: [{clientY: 100}]})
        await dragTo(150)
        expect(mounted.wrapper.find('dialog').attributes('style')).toContain('translateY(50px)')
        await artwork.trigger('touchend')
        await flushPromises()
        expect(mounted.router.currentRoute.value.hash).toBe('#player')

        await artwork.trigger('touchstart', {touches: [{clientY: 100}]})
        await dragTo(250)
        await artwork.trigger('touchend')
        await flushPromises()
        expect(mounted.router.currentRoute.value.hash).toBe('')
    })

    it('has no queue controls when nothing is queued after the current episode', async () => {
        const mounted = await openFullPlayer([episode()])
        expect(mounted.wrapper.find('dialog').classes()).not.toContain('has-queue')
        expect(mounted.wrapper.find('dialog .queue-toggle').exists()).toBe(false)
        expect(mounted.wrapper.find('dialog .queue-panel').exists()).toBe(false)
    })

    it('goes back to the artwork when the last queued episode is removed', async () => {
        const [current, upNext] = [episode(), episode()]
        stubClient('removeQueueItem', ok([current]))
        const mounted = await openFullPlayer([current, upNext])
        await mounted.wrapper.find('dialog .queue-toggle').trigger('click')
        await mounted.wrapper.find('dialog .queue-item [title="Remove from queue"]').trigger('click')
        await flushPromises()

        expect(mounted.wrapper.find('dialog').classes()).not.toContain('is-queue-shown')
        expect(mounted.wrapper.find('dialog .queue-panel').exists()).toBe(false)
    })

    it('closes itself once the queue has run out', async () => {
        const mounted = await openFullPlayer([episode()], '/downloads')
        mounted.queueStore.loadState = 'loaded'
        mounted.queueStore.items = []
        await flushPromises()
        expect(mounted.router.currentRoute.value.fullPath).toBe('/downloads')
    })

    it('leaves a followed link in place, so Back returns to the player', async () => {
        const item = episode({guid: 'ep-1'})
        const mounted = await openFullPlayer([item], '/downloads')
        await mounted.router.push({name: 'item', params: {guid: 'ep-1'}})
        await flushPromises()
        expect(mounted.wrapper.find('dialog').exists()).toBe(false)
        expect(mounted.router.currentRoute.value.hash).toBe('')

        mounted.router.back()
        await flushPromises()
        expect(mounted.router.currentRoute.value.fullPath).toBe('/downloads#player')
        expect(mounted.wrapper.find('dialog').exists()).toBe(true)
    })

    // Memory history keeps no state, so a browser's is set by hand.
    function setHistoryState(router: Awaited<ReturnType<typeof mountPlayer>>['router'], state: Record<string, unknown>) {
        Object.defineProperty(router.options.history, 'state', {configurable: true, value: state})
    }

    it('undoes its own history entry on close, once only', async () => {
        const mounted = await openFullPlayer([episode()], '/subscriptions/A%20Show?x=1')
        setHistoryState(mounted.router, {openedOverPage: true})
        const back = vi.spyOn(mounted.router, 'back')
        const replace = vi.spyOn(mounted.router, 'replace')

        const close = mounted.wrapper.find('dialog [title="Close full player"]')
        await close.trigger('click')
        expect(back).toHaveBeenCalledOnce()
        expect(replace).not.toHaveBeenCalled()
        await flushPromises()
        expect(mounted.router.currentRoute.value.fullPath).toBe('/subscriptions/A%20Show?x=1')
    })

    it('stays on the page when there is no entry of its own to undo', async () => {
        const mounted = await openFullPlayer([episode()], '/downloads')
        setHistoryState(mounted.router, {})
        const back = vi.spyOn(mounted.router, 'back')

        await mounted.wrapper.find('dialog [title="Close full player"]').trigger('click')
        await flushPromises()
        expect(back).not.toHaveBeenCalled()
        expect(mounted.router.currentRoute.value.fullPath).toBe('/downloads')
    })

    it('drops an unfinished drag of the slider when the episode changes', async () => {
        const seekTarget = stubClient('modifyFeedItem', ok(undefined))
        const [current, next] = [episode(), episode()]
        const mounted = await openFullPlayer([current, next])
        await loadMetadata(mounted.wrapper, 300)
        const slider = mounted.wrapper.find<HTMLInputElement>('dialog input[type="range"]')
        slider.element.value = '150'
        await slider.trigger('input')
        expect(mounted.wrapper.find('dialog .times').text()).toContain('2:30')

        mounted.queueStore.items = [next]
        await flushPromises()
        expect(mounted.wrapper.find('dialog .times').text()).not.toContain('2:30')

        await slider.trigger('change')
        expect(seekTarget).not.toHaveBeenCalled()
    })

    it('forgets a drag the browser cancelled', async () => {
        const mounted = await openFullPlayer([episode()])
        await loadMetadata(mounted.wrapper, 300)
        const slider = mounted.wrapper.find<HTMLInputElement>('dialog input[type="range"]')
        slider.element.value = '150'
        await slider.trigger('input')

        await slider.trigger('pointercancel')
        expect(mounted.wrapper.find('dialog .times').text()).toContain('0:00')
    })
})

describe('error reporting', () => {
    it('reports a remote source that fails to load, and a media error, with the episode and element state', async () => {
        const reported = stubClient('reportClientEvents', ok(undefined))
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const item = episode({guid: 'ep-broken'})
        const {wrapper} = await mountPlayer([item])
        const audio = wrapper.find('audio').element as HTMLAudioElement

        // vueuse applies src as <source> children; a failed load fires on the <source>.
        audio.querySelector('source')?.dispatchEvent(new Event('error'))
        Object.defineProperty(audio, 'error', {configurable: true, value: {code: 3, message: 'PIPELINE_ERROR_DECODE'}})
        audio.dispatchEvent(new Event('error'))
        flush()

        const events: ClientLogEvent[] = reported.mock.calls.flatMap(([batch]) => batch)
        expect(events.map(e => e.message)).toEqual([
            'Audio playback failed: source could not be loaded',
            'Audio playback failed: media error',
        ])
        expect(events[1].details).toEqual(expect.objectContaining({
            feedItemGuid: 'ep-broken',
            enclosureUrl: 'https://cdn.example.com/episode.mp3',
            source: 'remote',
            mediaErrorCode: 3,
            mediaErrorMessage: 'PIPELINE_ERROR_DECODE',
        }))
    })
})
