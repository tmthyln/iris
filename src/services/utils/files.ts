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

const FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; Iris/1.0; +https://github.com/tmthyln/iris)'

const RSS_ACCEPT_MIMES = [
    'application/rss+xml',
    'application/rdf+xml;q=0.8',
    'application/atom+xml;q=0.6',
    'application/xml;q=0.4',
    'text/xml;q=0.4',
].join(', ')

export async function fetchRssFile(url: string): Promise<FetchFileResult> {
    const knownFeedUrl = resolveKnownFeedUrl(url)
    if (knownFeedUrl) {
        console.log(`[fetchRssFile] Resolved known feed URL: ${url} -> ${knownFeedUrl}`)
        return fetchRssFile(knownFeedUrl)
    }

    const response = await fetch(url, {
        headers: new Headers({
            'Accept': RSS_ACCEPT_MIMES,
            'User-Agent': FETCH_USER_AGENT,
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
                    requestUrl: url,
                    sha256Hash: await sha256Encode(text),
                },
            }
        } else {
            console.log(`[fetchRssFile] Content appears to be HTML, not RSS (url: ${url})`)

            if (isBotChallengePage(text)) {
                console.log(`[fetchRssFile] Detected bot challenge page (url: ${url})`)
                return {status: 'error', content: null, reason: 'blocked-by-bot-protection'}
            }

            const rssUrl = extractRssLinkFromHtml(text)
            if (rssUrl) {
                console.log(`[fetchRssFile] Found RSS link in HTML: ${rssUrl}`)
                return fetchRssFile(rssUrl)
            }
        }
    } else {
        console.log(`[fetchRssFile] Non-ok response from upstream: ${response.status} ${response.statusText} (url: ${url})`)
    }

    const htmlResponse = await fetch(url, {
        headers: {
            'Accept': 'text/html',
            'User-Agent': FETCH_USER_AGENT,
        },
    })

    if (htmlResponse.ok) {
        const htmlText = await htmlResponse.text()

        if (isBotChallengePage(htmlText)) {
            console.log(`[fetchRssFile] Detected bot challenge page in HTML fallback (url: ${url})`)
            return {status: 'error', content: null, reason: 'blocked-by-bot-protection'}
        }

        const rssUrl = extractRssLinkFromHtml(htmlText)
        if (rssUrl) {
            console.log(`[fetchRssFile] Found RSS link in HTML fallback: ${rssUrl}`)
            return fetchRssFile(rssUrl)
        }
    }

    return {
        status: 'error',
        content: null,
        reason: response.ok ? 'no-rss-link-found' : `upstream-error-${response.status}`,
    }
}

const RSS_LINK_TYPES = ['application/rss+xml', 'application/atom+xml']

function extractRssLinkFromHtml(html: string): string | null {
    const parser = new XMLParser({
        ignoreAttributes: false,
        allowBooleanAttributes: true,
        ignoreDeclaration: true,
        ignorePiTags: true,
        unpairedTags: ['link', 'meta', 'br', 'hr', 'img', 'input'],
        stopNodes: ['*.script', '*.style', '*.body'],
    })
    const doc = parser.parse(html)
    const head = doc?.html?.head
    if (!head) return null

    const links = Array.isArray(head.link) ? head.link : [head.link]
    for (const link of links) {
        if (link && RSS_LINK_TYPES.includes(link['@_type']) && link['@_href']) {
            return link['@_href']
        }
    }
    return null
}

const KNOWN_FEED_URL_RULES: {pattern: RegExp, toFeedUrl: (match: RegExpMatchArray) => string}[] = [
    // Medium: https://medium.com/@user or https://user.medium.com
    {pattern: /^https?:\/\/medium\.com\/@([^/?#]+)/, toFeedUrl: m => `https://medium.com/feed/@${m[1]}`},
    {pattern: /^https?:\/\/([^.]+)\.medium\.com/, toFeedUrl: m => `https://medium.com/feed/@${m[1]}`},
    // Medium publications: https://medium.com/publication-name
    {pattern: /^https?:\/\/medium\.com\/(?!feed\/)([^@][^/?#]*)/, toFeedUrl: m => `https://medium.com/feed/${m[1]}`},
]

function resolveKnownFeedUrl(url: string): string | null {
    for (const {pattern, toFeedUrl} of KNOWN_FEED_URL_RULES) {
        const match = url.match(pattern)
        if (match) return toFeedUrl(match)
    }
    return null
}

function isBotChallengePage(html: string): boolean {
    const head = html.substring(0, 5000).toLowerCase()
    return head.includes('_cf_chl_opt')
        || head.includes('challenge-platform')
        || (head.includes('just a moment') && head.includes('cf-'))
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

    it('coalesce with simple mapping', () => {
        expect(coalesce({a: 1, b: 2, c: 3}, 'a')).toBe(1)
        expect(coalesce({a: 1, b: 2, c: 3}, 'a', 'b')).toBe(1)
        expect(coalesce({a: 1, b: 2, c: 3}, 'b')).toBe(2)
        expect(coalesce({a: 1, b: 2, c: 3}, 'b', 'a', 'c', 'nonexistent')).toBe(2)
    })

    describe('resolveKnownFeedUrl', () => {
        it('resolves medium.com/@user URLs', () => {
            expect(resolveKnownFeedUrl('https://medium.com/@netflixtechblog'))
                .toBe('https://medium.com/feed/@netflixtechblog')
        })

        it('resolves medium.com/@user URLs with trailing slash', () => {
            expect(resolveKnownFeedUrl('https://medium.com/@someuser/'))
                .toBe('https://medium.com/feed/@someuser')
        })

        it('resolves subdomain.medium.com URLs', () => {
            expect(resolveKnownFeedUrl('https://netflixtechblog.medium.com'))
                .toBe('https://medium.com/feed/@netflixtechblog')
            expect(resolveKnownFeedUrl('https://netflixtechblog.medium.com/'))
                .toBe('https://medium.com/feed/@netflixtechblog')
        })

        it('resolves medium.com/publication URLs', () => {
            expect(resolveKnownFeedUrl('https://medium.com/towards-data-science'))
                .toBe('https://medium.com/feed/towards-data-science')
        })

        it('does not match medium.com/feed/ URLs (avoids infinite recursion)', () => {
            expect(resolveKnownFeedUrl('https://medium.com/feed/@netflixtechblog'))
                .toBeNull()
            expect(resolveKnownFeedUrl('https://medium.com/feed/towards-data-science'))
                .toBeNull()
        })

        it('returns null for non-matching URLs', () => {
            expect(resolveKnownFeedUrl('https://example.com/blog')).toBeNull()
            expect(resolveKnownFeedUrl('https://www.johndcook.com/blog/feed/')).toBeNull()
        })

        it('handles http URLs', () => {
            expect(resolveKnownFeedUrl('http://medium.com/@user'))
                .toBe('https://medium.com/feed/@user')
        })
    })

    describe('isBotChallengePage', () => {
        it('detects Cloudflare challenge by _cf_chl_opt', () => {
            expect(isBotChallengePage('<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt = {};</script></body></html>'))
                .toBe(true)
        })

        it('detects Cloudflare challenge by challenge-platform script', () => {
            expect(isBotChallengePage('<html><head></head><body><script src="/cdn-cgi/challenge-platform/something"></script></body></html>'))
                .toBe(true)
        })

        it('detects Cloudflare challenge by title and cf- class', () => {
            expect(isBotChallengePage('<html><head><title>Just a moment</title></head><body><div class="cf-browser-verification"></div></body></html>'))
                .toBe(true)
        })

        it('returns false for normal HTML pages', () => {
            expect(isBotChallengePage('<html><head><title>My Blog</title></head><body><p>Hello</p></body></html>'))
                .toBe(false)
        })

        it('returns false for normal RSS content', () => {
            expect(isBotChallengePage('<?xml version="1.0"?><rss><channel><title>Feed</title></channel></rss>'))
                .toBe(false)
        })
    })

    describe('extractRssLinkFromHtml', () => {
        it('extracts RSS link from standard HTML head', () => {
            const html = `<!DOCTYPE html><html><head>
                <title>My Blog</title>
                <link rel="alternate" type="application/rss+xml" title="RSS" href="https://example.com/feed.xml">
            </head><body></body></html>`
            expect(extractRssLinkFromHtml(html)).toBe('https://example.com/feed.xml')
        })

        it('extracts Atom link', () => {
            const html = `<!DOCTYPE html><html><head>
                <link rel="alternate" type="application/atom+xml" title="Atom" href="https://example.com/atom.xml">
            </head><body></body></html>`
            expect(extractRssLinkFromHtml(html)).toBe('https://example.com/atom.xml')
        })

        it('prefers first RSS link when multiple exist', () => {
            const html = `<!DOCTYPE html><html><head>
                <link rel="alternate" type="application/rss+xml" href="https://example.com/rss1.xml">
                <link rel="alternate" type="application/rss+xml" href="https://example.com/rss2.xml">
            </head><body></body></html>`
            expect(extractRssLinkFromHtml(html)).toBe('https://example.com/rss1.xml')
        })

        it('ignores non-RSS link elements', () => {
            const html = `<!DOCTYPE html><html><head>
                <link rel="stylesheet" type="text/css" href="/style.css">
                <link rel="alternate" type="application/rss+xml" href="https://example.com/feed.xml">
            </head><body></body></html>`
            expect(extractRssLinkFromHtml(html)).toBe('https://example.com/feed.xml')
        })

        it('returns null when no RSS link exists', () => {
            const html = `<!DOCTYPE html><html><head>
                <title>No Feed</title>
                <link rel="stylesheet" type="text/css" href="/style.css">
            </head><body></body></html>`
            expect(extractRssLinkFromHtml(html)).toBeNull()
        })

        it('returns null when head is missing', () => {
            const html = `<!DOCTYPE html><html><body><p>No head</p></body></html>`
            expect(extractRssLinkFromHtml(html)).toBeNull()
        })

        it('returns null for non-HTML content', () => {
            expect(extractRssLinkFromHtml('<?xml version="1.0"?><rss><channel></channel></rss>'))
                .toBeNull()
        })
    })
}
