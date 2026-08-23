import {afterEach, describe, expect, it, vi} from 'vitest'
import {nextTick, ref} from 'vue'
import {prefetchImagesFromHtml, useUnescapedHTML} from './htmlproc.ts'

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
