import {XMLParser} from "fast-xml-parser";
import {FetchFileResult} from "../types";

export async function sha256Encode(text: string) {
    const rawText = new TextEncoder().encode(text)
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', rawText))]
        .map(x => parseInt(x).toString(16).padStart(2, '0'))
        .join('')
}

/******************************************************************************
 * File retrieval
 *****************************************************************************/

const RSS_ACCEPT_MIMES = [
    'application/rss+xml',
    'application/rdf+xml;q=0.8',
    'application/atom+xml;q=0.6',
    'application/xml;q=0.4',
    'text/xml;q=0.4',
].join(', ')

export async function fetchRssFile(url: string): Promise<FetchFileResult> {
    const response = await fetch(url, {
        headers: new Headers({
            'Accept': RSS_ACCEPT_MIMES,
        }),
    })

    if (response.ok) {
        const text = await response.text()
        if (text.substring(0, 2000).toLowerCase().indexOf('<!doctype html>') < 0) {
            return {
                status: 'success',
                content: text,
                metadata: {
                    timestamp: response.headers.get('date') ?? Date(),
                    inputUrl: url,
                    requestUrl: url,
                    sha256Hash: await sha256Encode(text),
                },
            }
        } else {
            console.log('Content appears to be HTML')
        }
    } else {
        console.log(`Received non-ok response from upstream: ${response.status} ${response.statusText}`)
    }

    const htmlResponse = await fetch(url, {
        headers: {
            'Accept': 'text/html',
        },
    })

    if (htmlResponse.ok) {
        // TODO try to extract the actual rss url from head info
    }

    return {
        status: 'error',
        content: null,
        metadata: {
            inputUrl: url,
        },
    }
}

/**
 * Fetch a list of archived snapshots for a URL from the wayback machine.
 * Docs: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server
 *
 * @param url
 */
export async function fetchArchiveList(url: string) {
    const currentYear = new Date().getFullYear()
    const queryParams = [
        `url=${encodeURIComponent(url)}`,
        `matchType=prefix`,
        `output=json`,
        `fl=timestamp,mimetype,statuscode,digest,length`,
        `from=${currentYear - 15}`,
        `filter=statuscode:200`,
        `filter=!mimetype:text/html`,
        `collapse=timestamp:8`,
        `collapse=digest`,
    ].join('&')
    const response = await fetch(`https://web.archive.org/cdx/search/cdx?${queryParams}`, {
        headers: {
            'Accept': 'application/json',
        },
    })

    if (response.ok) {
        const data = await response.json()
        return data.map(row => ({
            timestamp: parseInt(row[0]),
            mimetype: row[1],
            statuscode: parseInt(row[2]),
            digest: row[3],
            length: parseInt(row[4]),
        }))
    } else {
        return []
    }
}

/******************************************************************************
 * Parsers
 *****************************************************************************/

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
    description: string
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
        source_url: coalesce(channelData, 'atom:link.@_href', 'itunes:new-feed-url'),
        title: coalesce(channelData, 'title'),
        description: coalesce(channelData, 'description', 'itunes:summary') ?? '',
        author: coalesce(channelData, 'author', 'itunes:author', 'itunes:owner.itunes:name') ?? '',
        type: determineChannelType(channelData),
        image_src: coalesce(channelData, 'image.url', 'itunes:image.@_href'),
        image_alt: coalesce(channelData, 'image.title'),
        last_updated: coalesce(channelData, 'pubDate', 'lastBuildDate'),
        link: coalesce(channelData, 'link', 'image.link'),
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
        link: coalesce(item, 'link'),
        date: coalesce(item, 'pubDate'),
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
        return 60*60*parseInt(colonParts[0]) + 60*parseInt(colonParts[1] + parseInt(colonParts[2]))
    } else if (colonParts.length === 2) {
        return 60*parseInt(colonParts[0]) + parseInt(colonParts[1])
    }

    return typeof rawDuration === 'string' ? parseInt(rawDuration) : rawDuration
}

function determineDurationUnit(rawDuration: unknown) {
    return 'seconds'
}

function cleanList(rawListString: string | null) {
    if (rawListString === null)
        return ''

    return rawListString.split(',').map(raw => raw.trim()).join(',')
}

interface RecursiveMapping {
    [key: string]: RecursiveMapping | RecursiveMapping[] | string | number
}

function coalesce(mapping: RecursiveMapping, ...keys: string[]) {
    for (const key of keys) {
        const value = getMultikey(mapping, key)
        if (value !== null) {
            return value;
        }
    }

    return null
}

function getMultikey(mapping: RecursiveMapping, keyString: string) {
    const keyParts = keyString.split('.');
    let currentObjs = [mapping];

    for (const key of keyParts) {
        const newObjs = [] as RecursiveMapping[];
        for (const currentObj of currentObjs) {
            const currVal = currentObj[key]
            if (currVal) {
                if (Array.isArray(currVal)) {
                    newObjs.push(...currVal)
                } else if (typeof currVal === 'object') {
                    newObjs.push(currVal)
                }
            }
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
    const {it, expect} = import.meta.vitest

    it('coalesce with simple mapping', () => {
        expect(coalesce({a: 1, b: 2, c: 3}, 'a')).toBe(1)
        expect(coalesce({a: 1, b: 2, c: 3}, 'a', 'b')).toBe(1)
        expect(coalesce({a: 1, b: 2, c: 3}, 'b')).toBe(2)
        expect(coalesce({a: 1, b: 2, c: 3}, 'b', 'a', 'c', 'nonexistent')).toBe(2)
    })
}
