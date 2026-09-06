import {env} from 'cloudflare:workers'
import {afterEach, describe, expect, test, vi} from 'vitest'
import {enqueueTasks, retryDelaySeconds, runTask} from './tasks'
import {fakeQueue} from './testing/fixtures'
import type {FeedProcessingTask, RefreshFeedTask} from './types'

afterEach(() => {
    vi.restoreAllMocks()
})

describe('runTask', () => {
    test('ignores a task of unknown type without throwing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        await expect(runTask({type: 'unknown-task'} as unknown as FeedProcessingTask, env)).resolves.toBeUndefined()

        expect(warn).toHaveBeenCalledWith('Ignoring queue task of unknown type: unknown-task')
    })
})

describe('enqueueTasks', () => {
    test('splits the tasks into sendBatch calls of at most 100 messages', async () => {
        const queue = fakeQueue()
        const tasks = Array.from({length: 250}, (_, i): RefreshFeedTask => ({type: 'refresh-feed', feedGuid: `feed-${i}`}))

        await enqueueTasks(queue as unknown as Queue, tasks)

        expect(queue.sendBatch.mock.calls.map(([batch]) => [...batch].length)).toEqual([100, 100, 50])
        expect(queue.messages.map(m => m.body)).toEqual(tasks)
        expect(queue.send).not.toHaveBeenCalled()
    })

    test('sends nothing for an empty list', async () => {
        const queue = fakeQueue()

        await enqueueTasks(queue as unknown as Queue, [])

        expect(queue.sendBatch).not.toHaveBeenCalled()
    })
})

describe('retryDelaySeconds', () => {
    test('doubles from one minute per attempt', () => {
        expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([60, 120, 240, 480])
    })

    test('caps the delay at fifteen minutes', () => {
        expect(retryDelaySeconds(10)).toBe(900)
    })

    test('treats a missing attempt count as the first attempt', () => {
        expect(retryDelaySeconds(0)).toBe(60)
    })
})
