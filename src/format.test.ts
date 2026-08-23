import {describe, expect, it} from 'vitest'
import {nextTick, ref} from 'vue'
import {useDurationFormat} from './format.ts'

describe('useDurationFormat', () => {
    it.each([
        [0, '0:00'],
        [5, '0:05'],
        [65, '1:05'],
        [600, '10:00'],
        [3600, '1:0:00'],
        [3725, '1:2:05'],
        [7385, '2:3:05'],
    ])('formats %d seconds as %s', (seconds, expected) => {
        expect(useDurationFormat(seconds).value).toBe(expected)
    })

    it('rounds fractional seconds', () => {
        expect(useDurationFormat(59.4).value).toBe('0:59')
        expect(useDurationFormat(61.5).value).toBe('1:02')
    })

    it('tracks a reactive source', async () => {
        const duration = ref(30)
        const formatted = useDurationFormat(duration)
        expect(formatted.value).toBe('0:30')
        duration.value = 90
        await nextTick()
        expect(formatted.value).toBe('1:30')
    })
})
