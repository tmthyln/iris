import {afterEach, describe, expect, test, vi} from 'vitest'
import {mockFetch} from '../testing/fixtures'
import {FETCH_USER_AGENT} from './files'
import {fetchArchiveList, waybackSnapshotUrl} from './wayback'

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('fetchArchiveList', () => {
    test('queries the CDX API and maps the rows after the header', async () => {
        const {calls} = mockFetch(() => new Response(JSON.stringify([
            ['timestamp', 'original', 'digest'],
            ['20240101000000', 'https://example.com/feed', 'AAA'],
            ['20240201120000', 'https://example.com/feed?x=1', 'BBB'],
        ])))

        const snapshots = await fetchArchiveList('https://example.com/feed')

        expect(snapshots).toEqual([
            {timestamp: 20240101000000, original: 'https://example.com/feed', digest: 'AAA'},
            {timestamp: 20240201120000, original: 'https://example.com/feed?x=1', digest: 'BBB'},
        ])

        expect(calls).toHaveLength(1)
        const request = calls[0]
        const url = new URL(request.url)
        expect(url.origin + url.pathname).toBe('https://web.archive.org/cdx/search/cdx')
        expect(url.searchParams.get('url')).toBe('https://example.com/feed')
        expect(request.url).toContain('url=https%3A%2F%2Fexample.com%2Ffeed&')
        expect(url.searchParams.get('matchType')).toBe('prefix')
        expect(url.searchParams.get('output')).toBe('json')
        expect(url.searchParams.get('fl')).toBe('timestamp,original,digest')
        expect(url.searchParams.get('from')).toBe(String(new Date().getFullYear() - 15))
        expect(url.searchParams.get('filter')).toBe('statuscode:200')
        expect(url.searchParams.getAll('collapse')).toEqual(['timestamp:8', 'digest'])
        expect(request.headers.get('user-agent')).toBe(FETCH_USER_AGENT)
    })

    test('returns an empty list when the response only has the header row', async () => {
        mockFetch(() => new Response(JSON.stringify([['timestamp', 'original', 'digest']])))
        expect(await fetchArchiveList('https://example.com/feed')).toEqual([])
    })

    test('returns an empty list for a non-ok response', async () => {
        mockFetch(() => new Response('nope', {status: 503}))
        expect(await fetchArchiveList('https://example.com/feed')).toEqual([])
    })
})

describe('waybackSnapshotUrl', () => {
    test('formats the raw-content snapshot URL', () => {
        expect(waybackSnapshotUrl(20240101000000, 'https://example.com/feed?x=1'))
            .toBe('https://web.archive.org/web/20240101000000id_/https://example.com/feed?x=1')
    })
})
