import {afterEach, describe, expect, it, vi} from 'vitest'
import {nextTick, ref} from 'vue'
import {prefetchImagesFromHtml, safeLinkUrl, sanitizeHTML, useUnescapedHTML} from './htmlproc.ts'

describe('useUnescapedHTML', () => {
    it('decodes HTML entities to plain text', () => {
        expect(useUnescapedHTML('Tom &amp; Jerry &lt;3').value).toBe('Tom & Jerry <3')
    })

    it('drops markup, keeping text content', () => {
        expect(useUnescapedHTML('<b>Bold</b> move').value).toBe('Bold move')
    })

    it('tracks a reactive source', async () => {
        const raw = ref('a')
        const output = useUnescapedHTML(raw)
        expect(output.value).toBe('a')
        raw.value = 'b &amp; c'
        await nextTick()
        expect(output.value).toBe('b & c')
    })
})

describe('sanitizeHTML', () => {
    function parse(raw: string) {
        return new DOMParser().parseFromString(sanitizeHTML(raw), 'text/html').body
    }

    it('returns an empty string for missing content', () => {
        expect(sanitizeHTML(null)).toBe('')
        expect(sanitizeHTML(undefined)).toBe('')
    })

    it('keeps ordinary article markup', () => {
        const body = parse(`
            <h2 style="text-align: center">Title</h2>
            <p class="intro">Some <a href="https://example.com/a" title="A">link</a></p>
            <img src="https://example.com/a.png" alt="A" width="10">
            <blockquote>Quote</blockquote>
            <audio controls src="https://example.com/a.mp3"></audio>`)

        expect(body.querySelector('h2')?.getAttribute('style')).toBe('text-align: center')
        expect(body.querySelector('p')?.className).toBe('intro')
        expect(body.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a')
        expect(body.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png')
        expect(body.querySelector('blockquote')?.textContent).toBe('Quote')
        expect(body.querySelector('audio')?.hasAttribute('controls')).toBe(true)
    })

    it.each([
        ['script tags', '<script>alert(1)</script><p>x</p>'],
        ['event handlers', '<img src="https://example.com/a.png" onerror="alert(1)">'],
        ['javascript: links', '<a href="javascript:alert(1)">x</a>'],
        ['obfuscated javascript: links', '<a href="jav&#x09;ascript:alert(1)">x</a>'],
        ['data: links', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
        ['svg scripts', '<svg><script>alert(1)</script></svg>'],
        ['svg animation of an href', '<svg><a><animate attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>'],
        ['mutation through foreign content', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>'],
    ])('removes %s', (_name, raw) => {
        const clean = sanitizeHTML(raw)
        expect(clean).not.toMatch(/<script|onerror|javascript:|data:text/i)
    })

    it.each(['style', 'form', 'input', 'button', 'select', 'textarea', 'object', 'embed', 'link', 'meta', 'base'])('removes <%s>', tag => {
        expect(parse(`<${tag} name="x"></${tag}><p>kept</p>`).querySelector(tag)).toBeNull()
    })

    it('drops autoplay from media', () => {
        expect(parse('<video autoplay controls></video>').querySelector('video')?.hasAttribute('autoplay')).toBe(false)
    })

    describe('embeds', () => {
        it('keeps a cross-origin https iframe, sandboxed', () => {
            const iframe = parse('<iframe src="https://www.youtube.com/embed/x" width="560" allowfullscreen></iframe>').querySelector('iframe')!

            expect(iframe.getAttribute('src')).toBe('https://www.youtube.com/embed/x')
            expect(iframe.getAttribute('width')).toBe('560')
            expect(iframe.hasAttribute('allowfullscreen')).toBe(true)
            expect(iframe.getAttribute('sandbox')).toContain('allow-scripts')
            expect(iframe.getAttribute('sandbox')).not.toContain('allow-top-navigation')
        })

        it('replaces a sandbox the feed supplied', () => {
            const iframe = parse('<iframe src="https://example.org/" sandbox="allow-top-navigation"></iframe>').querySelector('iframe')!
            expect(iframe.getAttribute('sandbox')).not.toContain('allow-top-navigation')
        })

        it('resolves a protocol-relative src against the page', () => {
            vi.stubGlobal('location', new URL('https://iris.example.com/'))
            const iframe = parse('<iframe src="//player.example.org/x"></iframe>').querySelector('iframe')!
            expect(iframe.getAttribute('src')).toBe('https://player.example.org/x')
            vi.unstubAllGlobals()
        })

        it.each([
            ['plain http', '<iframe src="http://example.org/"></iframe>'],
            ['javascript:', '<iframe src="javascript:alert(1)"></iframe>'],
            ['srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
            ['no src', '<iframe></iframe>'],
            ['the app itself', '<iframe src="/api/feed"></iframe>'],
        ])('removes an iframe with %s', (_name, raw) => {
            expect(parse(raw).querySelector('iframe')).toBeNull()
        })
    })
})

describe('safeLinkUrl', () => {
    it.each(['https://example.com/a?b=c', 'http://example.com/', 'HTTPS://EXAMPLE.COM/'])('keeps %s', url => {
        expect(safeLinkUrl(url)).toBe(url)
    })

    it.each([
        'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)',
        'data:text/html,x', 'vbscript:x', 'not a url', '/relative', '', null, undefined,
    ])('rejects %j', url => {
        expect(safeLinkUrl(url)).toBeUndefined()
    })
})

describe('prefetchImagesFromHtml', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('creates one detached Image per unique src across all sources', () => {
        const fetched: string[] = []
        vi.stubGlobal('Image', class {
            set src(value: string) { fetched.push(value) }
        })
        prefetchImagesFromHtml(
            '<p><img src="https://a/1.png"><img src="https://a/2.png"></p>',
            null,
            '<img src="https://a/1.png">',   // duplicate, skipped
            undefined,
            '<p>no images here</p>',
        )
        expect(fetched.sort()).toEqual(['https://a/1.png', 'https://a/2.png'])
    })

    it('ignores img tags without a src', () => {
        const fetched: string[] = []
        vi.stubGlobal('Image', class {
            set src(value: string) { fetched.push(value) }
        })
        prefetchImagesFromHtml('<img><img src="">')
        expect(fetched).toEqual([])
    })
})
