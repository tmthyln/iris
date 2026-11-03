import type {TranscriptSegment} from "./types"

// Whisper's segments are timing units that often end mid-sentence, so they are
// grouped for reading: a paragraph ends at the first sentence end once it is
// long enough, or anywhere after too long without one (some languages come back
// with little punctuation), and always at a long pause.
const MIN_PARAGRAPH_SECONDS = 20
const MAX_PARAGRAPH_SECONDS = 60
const PAUSE_SECONDS = 8

const SENTENCE_END = /[.?!。？！]["'”’)）]*$/

export interface TranscriptParagraph {
    start: number | undefined
    segments: Array<{start: number | undefined, text: string}>
}

export function groupIntoParagraphs(segments: readonly TranscriptSegment[]): TranscriptParagraph[] {
    const paragraphs: TranscriptParagraph[] = []
    let current: TranscriptParagraph | null = null
    let previous: TranscriptSegment | null = null

    for (const segment of segments) {
        const text = segment.text ?? ''
        if (!text.trim()) continue

        const start = segment.start ?? 0
        const length = start - (current?.start ?? start)
        const pause = previous ? start - (previous.end ?? start) : 0
        const endedSentence = SENTENCE_END.test(previous?.text?.trim() ?? '')
        const breakHere = pause >= PAUSE_SECONDS
            || length >= MAX_PARAGRAPH_SECONDS
            || (length >= MIN_PARAGRAPH_SECONDS && endedSentence)

        if (!current || breakHere) {
            current = {start: segment.start, segments: []}
            paragraphs.push(current)
        }
        // Whisper starts Latin text with a space but not CJK, whose segments
        // still need separating where they carry no punctuation.
        const needsSpace = current.segments.length > 0 && !/^\s/.test(text) && !/[,，、;；:：.?!。？！]\s*$/.test(previous?.text ?? '')
        current.segments.push({start: segment.start, text: needsSpace ? ` ${text}` : text})
        previous = segment
    }
    return paragraphs
}

if (import.meta.vitest) {
    const {describe, expect, it} = import.meta.vitest
    const seg = (start: number, end: number, text: string) => ({start, end, text})
    const texts = (paragraphs: TranscriptParagraph[]) => paragraphs.map(p => p.segments.map(s => s.text).join(''))

    describe('groupIntoParagraphs', () => {
        it('joins fragments of a sentence and breaks at a sentence end once long enough', () => {
            const paragraphs = groupIntoParagraphs([
                seg(0, 10, ' Picture the scene. You are'),
                seg(10, 21, ' scrolling through a village.'),
                seg(21, 25, ' Is that real?'),
                seg(25, 30, ' Maybe.'),
            ])
            expect(texts(paragraphs)).toEqual([' Picture the scene. You are scrolling through a village.', ' Is that real? Maybe.'])
            expect(paragraphs.map(p => p.start)).toEqual([0, 21])
        })

        it('does not break at a sentence end while the paragraph is short', () => {
            expect(groupIntoParagraphs([seg(0, 5, ' One.'), seg(5, 10, ' Two.')])).toHaveLength(1)
        })

        it('breaks at a long pause, and after too long without a sentence end', () => {
            expect(groupIntoParagraphs([seg(0, 2, ' a'), seg(10, 12, ' b')])).toHaveLength(2)
            expect(groupIntoParagraphs([seg(0, 30, ' a'), seg(30, 60, ' b'), seg(60, 70, ' c')])).toHaveLength(2)
        })

        it('separates unpunctuated CJK segments but not punctuated ones', () => {
            expect(texts(groupIntoParagraphs([seg(0, 2, '二战结束之后'), seg(2, 4, '台湾就被'), seg(4, 6, '国民党管,'), seg(6, 8, '然后')])))
                .toEqual(['二战结束之后 台湾就被 国民党管,然后'])
        })

        it('skips blank segments', () => {
            expect(groupIntoParagraphs([seg(0, 1, ' '), seg(1, 2, ' words')]).map(p => p.start)).toEqual([1])
        })
    })
}
