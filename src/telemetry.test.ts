import {createApp} from 'vue'
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import client, {apiFetch} from './client'
import {flush, installErrorReporting, report} from './telemetry'
import {ok, stubClient, testRouter} from './testing/helpers'
import type {ClientLogEvent} from './types'

function sentEvents(): ClientLogEvent[] {
    return vi.mocked(client.reportClientEvents).mock.calls.flatMap(([events]) => events)
}

beforeEach(() => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    stubClient('reportClientEvents', ok(undefined))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
    flush()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

// Telemetry state is per page load (module-level), so each test reports
// messages of its own.
describe('report', () => {
    it('mirrors to the console and sends the batch shortly after', async () => {
        const failure = new Error('boom')
        report('error', 'Download failed', {requestId: 'req-1', error: failure, details: {feedItemGuid: 'item-a', skipped: undefined}})

        expect(console.error).toHaveBeenCalledWith('Download failed', failure, {feedItemGuid: 'item-a', skipped: undefined})
        expect(client.reportClientEvents).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(2000)
        expect(client.reportClientEvents).toHaveBeenCalledTimes(1)
        expect(sentEvents()).toEqual([{
            level: 'error',
            message: 'Download failed',
            requestId: 'req-1',
            stack: failure.stack,
            url: window.location.href,
            at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
            details: {feedItemGuid: 'item-a', error: 'Error: boom'},
        }])
    })

    it('drops identical reports after the third', () => {
        for (let i = 0; i < 5; i++) report('warn', 'Repeated warning', {details: {n: 1}})
        report('warn', 'Repeated warning', {details: {n: 2}})
        flush()

        expect(sentEvents().map(e => e.details)).toEqual([{n: 1}, {n: 1}, {n: 1}, {n: 2}])
    })

    it('sends in batches the Worker accepts', () => {
        for (let i = 0; i < 30; i++) report('info', `Batched ${i}`)
        flush()

        expect(vi.mocked(client.reportClientEvents).mock.calls.map(([events]) => events.length)).toEqual([25, 5])
    })
})

describe('installErrorReporting', () => {
    const app = createApp({render: () => null})

    beforeAll(() => {
        // Installs global listeners, so only once for the file.
        installErrorReporting(app, testRouter())
    })
    afterEach(() => {
        Reflect.deleteProperty(navigator, 'onLine')
    })

    it('reports Vue errors', () => {
        app.config.errorHandler?.(new TypeError('x is undefined'), null, 'render function')
        flush()

        expect(sentEvents()).toEqual([expect.objectContaining({
            level: 'error',
            message: 'Vue error: TypeError: x is undefined',
            details: {vueInfo: 'render function', error: 'TypeError: x is undefined'},
        })])
    })

    it('reports uncaught errors and unhandled rejections', () => {
        window.dispatchEvent(new ErrorEvent('error', {message: 'Uncaught boom', error: new Error('boom'), filename: 'app.js', lineno: 3, colno: 7}))
        window.dispatchEvent(Object.assign(new Event('unhandledrejection'), {reason: new Error('rejected')}))
        flush()

        expect(sentEvents()).toEqual([
            expect.objectContaining({
                message: 'Uncaught error: Uncaught boom',
                details: {source: 'app.js', line: 3, column: 7, error: 'Error: boom'},
            }),
            expect.objectContaining({message: 'Unhandled promise rejection: Error: rejected'}),
        ])
    })

    it('reports failed API calls under their request id, except the report endpoint and offline failures', async () => {
        vi.stubGlobal('fetch', vi.fn((input: string) => input === '/api/feed/offline'
            ? Promise.reject(new TypeError('Failed to fetch'))
            : Promise.resolve(new Response('{"error":"Upstream fetch failed"}', {status: input.includes('missing') ? 404 : 502}))))

        await apiFetch('/api/feeditem/item-a/media', {headers: {'X-Request-Id': 'req-media'}})
        await apiFetch('/api/feed/missing', {headers: {'X-Request-Id': 'req-missing'}})
        await apiFetch('/api/client-log', {method: 'POST'})
        Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => false})
        await expect(apiFetch('/api/feed/offline')).rejects.toThrow()
        await vi.waitFor(() => {
            flush()
            expect(sentEvents()).toHaveLength(2)
        })
        vi.unstubAllGlobals()

        expect(sentEvents()).toEqual([
            expect.objectContaining({
                level: 'error',
                message: 'API GET /api/feeditem/item-a/media failed',
                requestId: 'req-media',
                details: {method: 'GET', path: '/api/feeditem/item-a/media', status: 502, error: 'Upstream fetch failed'},
            }),
            expect.objectContaining({level: 'warn', requestId: 'req-missing', details: expect.objectContaining({status: 404})}),
        ])
    })
})
