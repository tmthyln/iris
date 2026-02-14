import {XMLParser} from "fast-xml-parser";

export interface ChannelData {
    guid: string
    source_url: string
    title: string
    description: string
    author: string
    type: string
    image_src: string | null
    image_alt: string | null
    last_updated: string
    link: string
    categories: string
}

export interface ChannelItemData {
    guid: string
    season: number | null
    episode: number | null
    title: string
    description: string | null
    link: string
    date: string
    enclosure_url: string | null
    enclosure_length: number | null
    enclosure_type: string | null
    duration: number | null
    duration_unit: string | null
    encoded_content: string
    keywords: string
}

interface ParsedFeedData {
    channel: ChannelData
    items: ChannelItemData[]
}

export function parseRssText(rawText: string): ParsedFeedData {
    const parser = new XMLParser({
        ignoreAttributes: false,
        allowBooleanAttributes: true,
        ignoreDeclaration: true,
        ignorePiTags: true,
    })
    let rssData = parser.parse(rawText)
    if (Object.prototype.hasOwnProperty.call(rssData, 'rss'))
        rssData = rssData.rss
    const channelData = rssData.channel
    const itemData = Array.isArray(channelData.item) ? channelData.item : [channelData.item]

    const channel = {
        guid: coalesce(channelData, 'guid', 'podcast:guid', 'id', 'title'),
        source_url: coalesce(channelData, 'link', 'atom:link.@_href', 'itunes:new-feed-url') ?? '',
        title: coalesce(channelData, 'title', 'image.title'),
        description: coalesce(channelData, 'description', 'itunes:summary') ?? '',
        author: coalesce(channelData, 'author', 'itunes:author', 'itunes:owner.itunes:name') ?? '',
        type: determineChannelType(channelData),
        image_src: coalesce(channelData, 'image.url', 'itunes:image.@_href'),
        image_alt: coalesce(channelData, 'image.title'),
        last_updated: coalesce(channelData, 'pubDate', 'lastBuildDate') ?? new Date().toISOString(),
        link: coalesce(channelData, 'link', 'image.link') ?? '',
        categories: '',
    }

    return {
        channel,
        items: itemData.map(processChannelItem)
    }
}

function processChannelItem(item: object) {
    return {
        guid: coalesce(item, 'guid', 'id', 'title'),
        season: coalesce(item, 'season', 'itunes:season', 'podcast:season'),
        episode: coalesce(item, 'episode', 'itunes:episode', 'podcast:episode'),
        title: coalesce(item, 'title', 'itunes:title'),
        description: coalesce(item, 'description', 'itunes:summary', 'itunes:subtitle'),
        link: coalesce(item, 'link') ?? '',
        date: coalesce(item, 'pubDate', 'atom:updated'),
        enclosure_url: coalesce(item, 'enclosure.@_url'),
        enclosure_length: coalesce(item, 'enclosure.@_length'),
        enclosure_type: coalesce(item, 'enclosure.@_type'),
        duration: parseDuration(coalesce(item, 'itunes:duration')),
        duration_unit: determineDurationUnit(coalesce(item, 'itunes:duration')),
        encoded_content: coalesce(item, 'content:encoded', 'content'),
        keywords: cleanList(coalesce(item, 'itunes:keywords')),
    }
}

function determineChannelType(channelData: Record<string, unknown>) {
    const hasITunes = ['itunes:summary', 'itunes:type', 'itunes:author']
        .reduce((hasITunes, key) => hasITunes || Object.prototype.hasOwnProperty.call(channelData, key), false)
    const hasPodcast = ['podcast:guid', 'podcast:locked', 'podcast:person', 'podcast:podping']
        .reduce((hasPodcast, key) => hasPodcast || Object.prototype.hasOwnProperty.call(channelData, key), false)

    if (hasITunes || hasPodcast) {
        return 'podcast'
    } else {
        return 'blog'
    }
}

/******************************************************************************
 * Generic Helpers
 *****************************************************************************/

function parseDuration(rawDuration: number | string | null) {
    if (rawDuration === null)
        return 0

    const colonParts = String(rawDuration).split(':');
    if (colonParts.length === 3) {
        return 60*60*parseInt(colonParts[0]) + 60*parseInt(colonParts[1]) + parseInt(colonParts[2])
    } else if (colonParts.length === 2) {
        return 60*parseInt(colonParts[0]) + parseInt(colonParts[1])
    }

    return typeof rawDuration === 'string' ? parseInt(rawDuration) : rawDuration
}

function determineDurationUnit(_rawDuration: unknown) {
    return 'seconds'
}

function cleanList(rawListString: string | null) {
    if (rawListString === null)
        return ''

    return rawListString.split(',').map(raw => raw.trim()).join(',')
}

function coalesce(mapping, ...keys: string[]) {
    for (const key of keys) {
        const value = getMultikey(mapping, key)
        if (value !== null) {
            return value;
        }
    }

    return null
}

function getMultikey(mapping, keyString: string) {
    const keyParts = keyString.split('.');
    let currentObjs = [mapping];

    for (const key of keyParts) {
        const newObjs = [];
        const primitives = [];
        for (const currentObj of currentObjs) {
            const currVal = currentObj[key]
            if (currVal !== undefined && currVal !== null && currVal !== false && currVal !== '') {
                if (Array.isArray(currVal)) {
                    newObjs.push(...currVal)
                } else if (typeof currVal === 'object') {
                    newObjs.push(currVal)
                } else {
                    primitives.push(currVal)
                }
            }
        }

        if (primitives.length > 0) {
            return primitives[0];
        }

        if (newObjs.length === 0) {
            return null;
        }

        currentObjs = newObjs;
    }

    for (const obj of currentObjs) {
        if (obj['#text']) {
            return obj['#text']
        } else if (obj) {
            return obj
        }
    }
    return null;
}

/******************************************************************************
 * Tests (of non-exported functions)
 *****************************************************************************/

if (import.meta.vitest) {
    const {it, expect, describe} = import.meta.vitest

    describe('coalesce', () => {
        it('returns first matching key value', () => {
            expect(coalesce({a: 1, b: 2, c: 3}, 'a')).toBe(1)
            expect(coalesce({a: 1, b: 2, c: 3}, 'a', 'b')).toBe(1)
            expect(coalesce({a: 1, b: 2, c: 3}, 'b')).toBe(2)
            expect(coalesce({a: 1, b: 2, c: 3}, 'b', 'a', 'c', 'nonexistent')).toBe(2)
        })

        it('returns null when no keys match', () => {
            expect(coalesce({a: 1}, 'x', 'y')).toBeNull()
            expect(coalesce({}, 'a')).toBeNull()
        })

        it('skips null, undefined, false, and empty string values', () => {
            expect(coalesce({a: null, b: 'real'}, 'a', 'b')).toBe('real')
            expect(coalesce({a: undefined, b: 42}, 'a', 'b')).toBe(42)
            expect(coalesce({a: false, b: 'yes'}, 'a', 'b')).toBe('yes')
            expect(coalesce({a: '', b: 'nonempty'}, 'a', 'b')).toBe('nonempty')
        })

        it('resolves dotted keys for nested objects', () => {
            expect(coalesce({image: {url: 'pic.jpg'}}, 'image.url')).toBe('pic.jpg')
            expect(coalesce({a: {b: {c: 'deep'}}}, 'a.b.c')).toBe('deep')
        })

        it('falls back through dotted keys', () => {
            expect(coalesce({x: {}}, 'x.missing', 'x.also_missing')).toBeNull()
            expect(coalesce({x: {a: 1}}, 'x.missing', 'x.a')).toBe(1)
        })

        it('extracts #text from objects (XML text nodes)', () => {
            expect(coalesce({guid: {'#text': 'abc', '@_isPermaLink': 'false'}}, 'guid')).toBe('abc')
        })

        it('traverses into arrays', () => {
            const data = {link: [{href: 'first'}, {href: 'second'}]}
            expect(coalesce(data, 'link.href')).toBe('first')
        })

        it('handles XML attribute keys', () => {
            expect(coalesce({'itunes:image': {'@_href': 'img.png'}}, 'itunes:image.@_href')).toBe('img.png')
        })

        it('returns 0 as a valid value (truthy check does not skip 0)', () => {
            expect(coalesce({episode: 0}, 'episode')).toBe(0)
        })
    })
}
