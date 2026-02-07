import {describe, it, expect} from 'vitest'
import {asBoolean, asDate, asStringList} from './conversion'

describe('asBoolean', () => {
    it('passes through true', () => {
        expect(asBoolean(true)).toBe(true)
    })

    it('passes through false', () => {
        expect(asBoolean(false)).toBe(false)
    })

    it('converts 1 to true', () => {
        expect(asBoolean(1)).toBe(true)
    })

    it('converts 0 to false', () => {
        expect(asBoolean(0)).toBe(false)
    })

    it('converts "1" to true', () => {
        expect(asBoolean('1')).toBe(true)
    })

    it('converts "0" to false', () => {
        expect(asBoolean('0')).toBe(false)
    })
})

describe('asDate', () => {
    it('passes through Date objects', () => {
        const d = new Date('2026-01-01')
        expect(asDate(d)).toBe(d)
    })

    it('converts ISO string to Date', () => {
        const result = asDate('2026-02-07T12:00:00Z')
        expect(result).toBeInstanceOf(Date)
        expect(result.getFullYear()).toBe(2026)
    })

    it('converts RSS date string to Date', () => {
        const result = asDate('Sat, 07 Feb 2026 14:02:45 +0000')
        expect(result).toBeInstanceOf(Date)
        expect(result.getUTCFullYear()).toBe(2026)
        expect(result.getUTCMonth()).toBe(1) // February = 1
        expect(result.getUTCDate()).toBe(7)
    })

    it('converts unix timestamp number to Date', () => {
        const result = asDate(1738886400000)
        expect(result).toBeInstanceOf(Date)
    })
})

describe('asStringList', () => {
    it('passes through arrays', () => {
        const arr = ['a', 'b', 'c']
        expect(asStringList(arr)).toEqual(['a', 'b', 'c'])
    })

    it('splits comma-separated string', () => {
        expect(asStringList('a,b,c')).toEqual(['a', 'b', 'c'])
    })

    it('trims whitespace from items', () => {
        expect(asStringList('a , b , c')).toEqual(['a', 'b', 'c'])
    })

    it('filters out empty strings', () => {
        expect(asStringList('a,,b,')).toEqual(['a', 'b'])
    })

    it('returns empty array for empty string', () => {
        expect(asStringList('')).toEqual([])
    })
})