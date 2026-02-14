import {XMLParser} from "fast-xml-parser";
import {FetchFileResult} from "../types";
import {sha256Encode} from "./crypto";

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

/******************************************************************************
 * Tests (of non-exported functions)
 *****************************************************************************/

if (import.meta.vitest) {
    const {it, expect, describe} = import.meta.vitest

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
