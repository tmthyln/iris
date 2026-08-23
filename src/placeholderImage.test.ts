import {describe, expect, it} from 'vitest'
import {ref} from 'vue'
import {usePlaceholderImage} from './placeholderImage.ts'

const SVG_PREFIX = 'data:image/svg+xml,'

function decode(dataUri: string) {
    expect(dataUri.startsWith(SVG_PREFIX)).toBe(true)
    return decodeURIComponent(dataUri.slice(SVG_PREFIX.length))
}

describe('usePlaceholderImage', () => {
    it('passes a real image src through', () => {
        const {resolvedSrc} = usePlaceholderImage(ref('https://example.com/a.png'), ref('My Feed'))
        expect(resolvedSrc.value).toBe('https://example.com/a.png')
    })

    it('generates an SVG placeholder when there is no image', () => {
        const {resolvedSrc} = usePlaceholderImage(ref(null), ref('my feed'), 64)
        const svg = decode(resolvedSrc.value)
        expect(svg).toContain('<svg')
        expect(svg).toContain('width="64"')
        expect(svg).toMatch(/>\s*M\s*</)   // first letter, uppercased
    })

    it('falls back to the placeholder after an image load error', () => {
        const imageSrc = ref<string | null>('https://example.com/broken.png')
        const {resolvedSrc, onImageError} = usePlaceholderImage(imageSrc, ref('Feed'))
        expect(resolvedSrc.value).toBe('https://example.com/broken.png')
        onImageError()
        expect(resolvedSrc.value.startsWith(SVG_PREFIX)).toBe(true)
    })

    it('derives a deterministic colour from the name', () => {
        const first = usePlaceholderImage(ref(null), ref('Same Name')).resolvedSrc.value
        const second = usePlaceholderImage(ref(null), ref('Same Name')).resolvedSrc.value
        expect(first).toBe(second)
        expect(decode(first)).toMatch(/fill="hsl\(\d+, 65%, 45%\)"/)
    })

    it('uses "?" for an empty name', () => {
        const {resolvedSrc} = usePlaceholderImage(ref(null), ref(''))
        expect(decode(resolvedSrc.value)).toMatch(/>\s*\?\s*</)
    })
})
