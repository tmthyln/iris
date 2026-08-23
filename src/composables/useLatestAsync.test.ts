import {describe, expect, it} from 'vitest'
import {useLatestAsync} from './useLatestAsync.ts'

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return {promise, resolve, reject}
}

describe('useLatestAsync', () => {
    it('returns the result of a single call and passes arguments through', async () => {
        const {execute} = useLatestAsync((a: number, b: number) => Promise.resolve(a + b))
        expect(await execute(2, 3)).toBe(5)
    })

    it('resolves superseded calls to null, keeping only the latest result', async () => {
        const pending: Array<ReturnType<typeof deferred<string>>> = []
        const {execute} = useLatestAsync(() => {
            const d = deferred<string>()
            pending.push(d)
            return d.promise
        })

        const first = execute()
        const second = execute()
        pending[0].resolve('first')
        pending[1].resolve('second')

        expect(await first).toBeNull()
        expect(await second).toBe('second')
    })

    it('nulls a stale call even when it settles after the newer one', async () => {
        const pending: Array<ReturnType<typeof deferred<string>>> = []
        const {execute} = useLatestAsync(() => {
            const d = deferred<string>()
            pending.push(d)
            return d.promise
        })

        const first = execute()
        const second = execute()
        pending[1].resolve('second')
        expect(await second).toBe('second')
        pending[0].resolve('slow first')
        expect(await first).toBeNull()
    })

    it('tracks loading across overlapping calls', async () => {
        const pending: Array<ReturnType<typeof deferred<string>>> = []
        const {execute, isLoading} = useLatestAsync(() => {
            const d = deferred<string>()
            pending.push(d)
            return d.promise
        })

        expect(isLoading.value).toBe(false)
        const first = execute()
        const second = execute()
        expect(isLoading.value).toBe(true)

        pending[0].resolve('a')
        await first
        expect(isLoading.value).toBe(true)   // second still in flight

        pending[1].resolve('b')
        await second
        expect(isLoading.value).toBe(false)
    })

    it('stops loading when a call rejects', async () => {
        const {execute, isLoading} = useLatestAsync(() => Promise.reject(new Error('boom')))
        await expect(execute()).rejects.toThrow('boom')
        expect(isLoading.value).toBe(false)
    })
})
