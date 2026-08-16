import {describe, expect, it} from 'vitest'
import {stripHtml} from './html'

describe('stripHtml', () => {
    it('removes tags and keeps text', () => {
        expect(stripHtml('<p>Hello <a href="https://example.com">world</a></p>'))
            .toBe('Hello world')
    })

    it('drops script and style contents entirely', () => {
        expect(stripHtml('<style>p { color: red }</style>Text<script>alert(1)</script>'))
            .toBe('Text')
    })

    it('decodes common entities', () => {
        expect(stripHtml('Fish &amp; chips &lt;3&nbsp;&quot;yum&quot;'))
            .toBe('Fish & chips <3 "yum"')
    })

    it('collapses whitespace across block boundaries', () => {
        expect(stripHtml('<p>one</p>\n<p>two</p>')).toBe('one two')
    })

    it('handles empty input', () => {
        expect(stripHtml('')).toBe('')
    })
})
