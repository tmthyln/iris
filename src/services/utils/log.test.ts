import {afterEach, describe, expect, test, vi} from 'vitest'
import {currentTrace, log, logContext, sanitizeId, serializeError, traced, withLogContext} from './log'

afterEach(() => vi.restoreAllMocks())

describe('log', () => {
    test('writes one object per line, with the context fields and a serialised error', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const failure = Object.assign(new Error('outer'), {cause: new TypeError('inner')})

        withLogContext({requestId: 'req-1', sessionId: 'sess-1'}, () => {
            log.error('Something failed', {feedGuid: 'feed-a', skipped: undefined, error: failure})
        })

        expect(error).toHaveBeenCalledTimes(1)
        const [line] = error.mock.calls[0] as [Record<string, unknown>]
        expect(line).toEqual({
            message: 'Something failed',
            requestId: 'req-1',
            sessionId: 'sess-1',
            feedGuid: 'feed-a',
            error: {
                name: 'Error',
                message: 'outer',
                stack: expect.any(String),
                cause: {name: 'TypeError', message: 'inner', stack: expect.any(String)},
            },
        })
    })

    test('routes levels to the matching console method', () => {
        const info = vi.spyOn(console, 'log').mockImplementation(() => {})
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        log.info('fine')
        log.warn('hmm')

        expect(info).toHaveBeenCalledWith({message: 'fine'})
        expect(warn).toHaveBeenCalledWith({message: 'hmm'})
    })

    test('serialises non-Error throwables', () => {
        expect(serializeError('plain')).toEqual({message: 'plain'})
        expect(serializeError({code: 1})).toEqual({message: '[object Object]'})
    })
})

describe('withLogContext', () => {
    test('nests, with inner fields overriding outer ones, and survives awaits', async () => {
        await withLogContext({requestId: 'outer', taskType: 'refresh-feed'}, async () => {
            await Promise.resolve()
            await withLogContext({requestId: 'inner', ignored: undefined}, async () => {
                await new Promise(resolve => setTimeout(resolve, 1))
                expect(logContext()).toEqual({requestId: 'inner', taskType: 'refresh-feed'})
            })
            expect(logContext()).toEqual({requestId: 'outer', taskType: 'refresh-feed'})
        })
        expect(logContext()).toEqual({})
    })
})

describe('traced', () => {
    test('attaches the current request and session ids to a task', () => {
        const task = {type: 'refresh-feed', feedGuid: 'feed-a'} as const

        expect(traced(task)).toEqual(task)
        withLogContext({requestId: 'req-1'}, () => {
            expect(currentTrace()).toEqual({requestId: 'req-1'})
            expect(traced(task)).toEqual({...task, trace: {requestId: 'req-1'}})
        })
        withLogContext({requestId: 'req-1', sessionId: 'sess-1'}, () => {
            expect(traced(task)).toEqual({...task, trace: {requestId: 'req-1', sessionId: 'sess-1'}})
        })
    })
})

describe('sanitizeId', () => {
    test('accepts short opaque tokens only', () => {
        expect(sanitizeId('6caa66cd-579b-48da-a21a-29e984f479cf')).toBe('6caa66cd-579b-48da-a21a-29e984f479cf')
        expect(sanitizeId(undefined)).toBeUndefined()
        expect(sanitizeId('')).toBeUndefined()
        expect(sanitizeId('has space')).toBeUndefined()
        expect(sanitizeId('x'.repeat(65))).toBeUndefined()
    })
})
