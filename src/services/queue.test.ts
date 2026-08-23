import {env} from 'cloudflare:workers'
import {beforeEach, describe, expect, test} from 'vitest'
import {getQueue} from './queue'

describe('ItemQueue', () => {
    beforeEach(async () => {
        await getQueue(env).clearQueue()
    })

    test('starts empty', async () => {
        expect(await getQueue(env).getItems()).toEqual([])
    })

    test('enqueueItem appends in order and ignores duplicates', async () => {
        const queue = getQueue(env)
        expect(await queue.enqueueItem('a')).toEqual(['a'])
        expect(await queue.enqueueItem('b')).toEqual(['a', 'b'])
        expect(await queue.enqueueItem('a')).toEqual(['a', 'b'])
    })

    test('insertItem places an item at an index, moving it if already queued', async () => {
        const queue = getQueue(env)
        await queue.enqueueItem('a')
        await queue.enqueueItem('b')
        await queue.enqueueItem('c')

        expect(await queue.insertItem('x', 1)).toEqual(['a', 'x', 'b', 'c'])
        expect(await queue.insertItem('c', 0)).toEqual(['c', 'a', 'x', 'b'])
    })

    test('insertItem clamps the index to the queue bounds', async () => {
        const queue = getQueue(env)
        await queue.enqueueItem('a')
        await queue.enqueueItem('b')

        expect(await queue.insertItem('front', -5)).toEqual(['front', 'a', 'b'])
        expect(await queue.insertItem('back', 99)).toEqual(['front', 'a', 'b', 'back'])
    })

    test('removeItem drops the item and keeps the remaining order', async () => {
        const queue = getQueue(env)
        await queue.enqueueItem('a')
        await queue.enqueueItem('b')
        await queue.enqueueItem('c')

        expect(await queue.removeItem('b')).toEqual(['a', 'c'])
        expect(await queue.removeItem('missing')).toEqual(['a', 'c'])
        // the compacted queue keeps appending after the last item
        expect(await queue.enqueueItem('d')).toEqual(['a', 'c', 'd'])
    })

    test('clearQueue empties the queue', async () => {
        const queue = getQueue(env)
        await queue.enqueueItem('a')
        expect(await queue.clearQueue()).toEqual([])
        expect(await queue.getItems()).toEqual([])
    })

    test('state persists across stubs for the same name', async () => {
        await getQueue(env).enqueueItem('a')
        expect(await getQueue(env, 'default').getItems()).toEqual(['a'])
    })

    test('getQueue returns independent queues per name', async () => {
        await getQueue(env).enqueueItem('a')
        const other = getQueue(env, 'other')
        expect(await other.getItems()).toEqual([])
        await other.enqueueItem('z')
        expect(await getQueue(env).getItems()).toEqual(['a'])
        expect(await other.getItems()).toEqual(['z'])
    })
})
