import {describe, test, expect} from 'vitest'
import {selectSnapshots, waybackTimestampToMs} from './flows'

describe('selectSnapshots', () => {
    test('returns empty for empty input', () => {
        expect(selectSnapshots([], 1000)).toEqual([])
    })

    test('returns single snapshot', () => {
        const snapshots = [{timestamp: 20230101120000, original: 'http://example.com/feed', digest: 'abc'}]
        expect(selectSnapshots(snapshots, 1000)).toEqual(snapshots)
    })

    test('always includes first and last', () => {
        const snapshots = [
            {timestamp: 20230101000000, original: 'http://example.com/feed', digest: 'a'},
            {timestamp: 20230102000000, original: 'http://example.com/feed', digest: 'b'},
            {timestamp: 20230103000000, original: 'http://example.com/feed', digest: 'c'},
        ]
        // with a very large interval, only first and last should be selected
        const result = selectSnapshots(snapshots, 365 * 24 * 60 * 60 * 1000)
        expect(result[0]).toEqual(snapshots[0])
        expect(result[result.length - 1]).toEqual(snapshots[2])
    })

    test('selects at interval spacing', () => {
        const snapshots = [
            {timestamp: 20230101000000, original: 'http://example.com/feed', digest: 'a'},
            {timestamp: 20230102000000, original: 'http://example.com/feed', digest: 'b'},
            {timestamp: 20230103000000, original: 'http://example.com/feed', digest: 'c'},
            {timestamp: 20230104000000, original: 'http://example.com/feed', digest: 'd'},
            {timestamp: 20230105000000, original: 'http://example.com/feed', digest: 'e'},
        ]
        // 2-day interval: should select indices 0, 2, 4
        const twoDays = 2 * 24 * 60 * 60 * 1000
        const result = selectSnapshots(snapshots, twoDays)
        expect(result).toEqual([snapshots[0], snapshots[2], snapshots[4]])
    })

    test('handles gaps by including both sides', () => {
        const snapshots = [
            {timestamp: 20230101000000, original: 'http://example.com/feed', digest: 'a'},
            {timestamp: 20230102000000, original: 'http://example.com/feed', digest: 'b'},
            // big gap here
            {timestamp: 20230201000000, original: 'http://example.com/feed', digest: 'c'},
            {timestamp: 20230202000000, original: 'http://example.com/feed', digest: 'd'},
        ]
        const sevenDays = 7 * 24 * 60 * 60 * 1000
        const result = selectSnapshots(snapshots, sevenDays)
        // Should include: first(0), gap-before(1), gap-after(2), last(3)
        expect(result).toEqual(snapshots)
    })
})

describe('waybackTimestampToMs', () => {
    test('parses full 14-digit timestamp', () => {
        // 2023-06-15T08:30:45Z
        expect(waybackTimestampToMs(20230615083045)).toBe(Date.UTC(2023, 5, 15, 8, 30, 45))
    })

    test('parses date-only timestamp (YYYYMMDD)', () => {
        // 2023-01-01T00:00:00Z
        expect(waybackTimestampToMs(20230101)).toBe(Date.UTC(2023, 0, 1, 0, 0, 0))
    })

    test('parses midnight timestamp with zeroed time', () => {
        expect(waybackTimestampToMs(20200301000000)).toBe(Date.UTC(2020, 2, 1, 0, 0, 0))
    })

    test('parses end-of-day timestamp', () => {
        expect(waybackTimestampToMs(20231231235959)).toBe(Date.UTC(2023, 11, 31, 23, 59, 59))
    })
})
