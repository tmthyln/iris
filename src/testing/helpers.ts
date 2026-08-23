/**
 * Shared helpers for the frontend's tests (the `node` vitest project, jsdom).
 *
 * Strategy: tests use real Pinia stores and stub the API boundary by spying on
 * the methods of the `client` object (`stubClient`) — no module mocking needed,
 * since `client` is a plain object. Components mount with a fresh Pinia and a
 * memory-history router whose routes mirror src/router/routes.ts.
 */
import {mount, type ComponentMountingOptions} from '@vue/test-utils'
import {createPinia, setActivePinia, type Pinia} from 'pinia'
import {vi, type MockInstance} from 'vitest'
import {defineComponent, h, type Component} from 'vue'
import {createMemoryHistory, createRouter, type Router} from 'vue-router'
import client from '../client.ts'
import type {
    ApiResult, Feed, FeedItem, FeedItemPreview, Notification, Transcript, TranscriptFull,
} from '../types.ts'

/******************************************************************************
 * API results and client stubbing
 *****************************************************************************/

export function ok<T>(data: T, status = 200): ApiResult<T> {
    return {ok: true, status, data}
}

export function err(status: number | null = 500, error = 'Test error'): ApiResult<never> {
    return {ok: false, status, error}
}

type ClientMethod = keyof typeof client

/**
 * Replace one `client` method with a resolved-value stub, returning the spy.
 * Restored by `vi.restoreAllMocks()` (e.g. in `afterEach`).
 */
export function stubClient<M extends ClientMethod>(
    method: M,
    result: Awaited<ReturnType<(typeof client)[M]>> | Error,
): MockInstance {
    const spy = vi.spyOn(client, method)
    if (result instanceof Error) {
        spy.mockRejectedValue(result)
    } else {
        spy.mockResolvedValue(result as never)
    }
    return spy
}

/** Stub a `client` method that keeps `pending` until the test resolves it. */
export function stubClientPending<M extends ClientMethod>(method: M) {
    type Result = Awaited<ReturnType<(typeof client)[M]>>
    let resolve!: (result: Result) => void
    const promise = new Promise<Result>(r => { resolve = r })
    const spy = vi.spyOn(client, method).mockReturnValue(promise as never)
    return {spy, resolve}
}

/******************************************************************************
 * Frontend model factories
 *****************************************************************************/

let sequence = 0
/** Monotonic counter so generated GUIDs are unique within a file. */
export function nextSequence() {
    return ++sequence
}

/** ISO date `n` days after 2024-01-01. */
export function dateAt(n: number) {
    return new Date(Date.UTC(2024, 0, 1) + n * 24 * 60 * 60 * 1000).toISOString()
}

export function makeFeed(overrides: Partial<Feed> = {}): Feed {
    const n = nextSequence()
    return {
        guid: `feed-${n}`,
        source_url: `https://example.com/feed-${n}/rss`,
        title: `Feed ${n}`,
        alias: '',
        description: `Description of feed ${n}`,
        author: `Author ${n}`,
        type: 'blog',
        ongoing: true,
        active: true,
        image_src: null,
        image_alt: null,
        last_updated: dateAt(n),
        update_frequency: 1,
        link: `https://example.com/feed-${n}`,
        categories: [],
        notify_enabled: false,
        has_unread: true,
        has_archives: false,
        ...overrides,
    }
}

export function makeItem(overrides: Partial<FeedItemPreview> = {}): FeedItemPreview {
    const n = nextSequence()
    return {
        guid: `item-${n}`,
        source_feed: 'feed-1',
        season: null,
        episode: null,
        title: `Item ${n}`,
        description: `Description of item ${n}`,
        link: `https://example.com/items/${n}`,
        date: dateAt(n),
        enclosure_url: null,
        enclosure_length: null,
        enclosure_type: null,
        duration: null,
        duration_unit: null,
        keywords: [],
        finished: false,
        progress: 0,
        bookmarked: false,
        ...overrides,
    }
}

export function makeFullItem(overrides: Partial<FeedItem> = {}): FeedItem {
    const {encoded_content = '<p>Full content</p>', ...preview} = overrides
    return {...makeItem(preview), encoded_content}
}

export function makeNotification(overrides: Partial<Notification> = {}): Notification {
    const n = nextSequence()
    return {
        id: n,
        type: 'new_item',
        feed_guid: `feed-${n}`,
        feed_item_guid: `item-${n}`,
        feed_title: `Feed ${n}`,
        feed_alias: null,
        item_title: `Item ${n}`,
        created_at: dateAt(n),
        dismissed: false,
        ...overrides,
    }
}

export function makeTranscript(overrides: Partial<Transcript> = {}): Transcript {
    const n = nextSequence()
    return {
        id: n,
        feed_item_guid: `item-${n}`,
        model: 'whisper',
        language: null,
        source_transcript_id: null,
        status: 'complete',
        error_message: null,
        requested_at: dateAt(n),
        started_at: dateAt(n),
        completed_at: dateAt(n),
        ...overrides,
    }
}

export function makeFullTranscript(overrides: Partial<TranscriptFull> = {}): TranscriptFull {
    const {text = 'Hello world', segments_json = null, ...rest} = overrides
    return {...makeTranscript(rest), text, segments_json}
}

/******************************************************************************
 * Browser push API stubs
 *****************************************************************************/

export function makeSubscription(endpoint = 'https://push.example/endpoint-1') {
    return {
        endpoint,
        toJSON: () => ({endpoint, keys: {p256dh: 'p', auth: 'a'}}),
        unsubscribe: vi.fn(() => Promise.resolve(true)),
    }
}

/**
 * Make jsdom look like a push-capable browser: navigator.serviceWorker with a
 * ready registration, a PushManager global and a Notification stub. Clean up
 * with `vi.unstubAllGlobals()` plus
 * `Reflect.deleteProperty(navigator, 'serviceWorker')`.
 */
export function stubBrowserPush({subscription = null as ReturnType<typeof makeSubscription> | null, permission = 'default'} = {}) {
    const pushManager = {
        getSubscription: vi.fn(() => Promise.resolve(subscription)),
        subscribe: vi.fn((_options?: PushSubscriptionOptionsInit) => Promise.resolve(makeSubscription())),
    }
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {ready: Promise.resolve({pushManager})},
    })
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', {
        permission,
        requestPermission: vi.fn(() => Promise.resolve('granted')),
    })
    return pushManager
}

/******************************************************************************
 * Mounting
 *****************************************************************************/

const Stub = defineComponent({render: () => h('div')})

/** Memory-history router with the app's route names (stubbed components). */
export function testRouter(): Router {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            {name: 'home', path: '/', component: Stub},
            {name: 'subscription', path: '/subscriptions/:guid', component: Stub, props: true},
            {name: 'item', path: '/subscriptions/item/:guid', component: Stub, props: true},
            {name: 'downloads', path: '/downloads', component: Stub},
        ],
    })
}

/**
 * Mount a component with a fresh Pinia (activated, so stores can be used and
 * seeded before or after) and a memory router, starting at `route`.
 */
export async function mountApp<C extends Component>(
    component: C,
    options: ComponentMountingOptions<C> = {},
    {route = '/', pinia}: {route?: string, pinia?: Pinia} = {},
) {
    const router = testRouter()
    await router.push(route)
    await router.isReady()

    const activePinia = pinia ?? createPinia()
    setActivePinia(activePinia)

    const wrapper = mount(component, {
        ...options,
        global: {
            ...options.global,
            plugins: [activePinia, router, ...(options.global?.plugins ?? [])],
        },
    })
    return {wrapper, router, pinia: activePinia}
}
