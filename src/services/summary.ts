import {stripHtml} from '../lib/html'
import {type FeedItemFingerprint, setFeedItemSummary} from './crud'
import {ServerFeedItem} from './models'
import type {SummarizeFeedItemTask} from './types'
import {sha256Encode} from './utils/files'
import {log} from './utils/log'

/**
 * Descriptions whose plain text is longer than this (about a hundred words,
 * several lines of a preview card) get a generated summary for previews.
 * The item view always shows the description itself.
 */
export const SUMMARY_THRESHOLD_CHARS = 600

/** Description text sent to the model is cut to this, to bound the prompt. */
const MAX_INPUT_CHARS = 8000

/** Workers AI model used for preview summaries. */
export const SUMMARY_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8'

const SYSTEM_PROMPT = [
    'You write the preview text for an item in a feed reader.',
    'Summarise the item description you are given in two or three sentences, at most 60 words,',
    'in the same language as the description.',
    'Say what the item is about. Use only information in the description;',
    'leave out sponsor messages, links, credits and requests to subscribe or follow.',
    'Reply with the summary text only: no heading, no preamble, no quotation marks.',
].join(' ')

/** The description as plain text, the form both the threshold and the hash use. */
export function descriptionText(description: string | null): string {
    return description ? stripHtml(description) : ''
}

export function needsSummary(description: string | null): boolean {
    return descriptionText(description).length > SUMMARY_THRESHOLD_CHARS
}

export async function summarySourceHash(description: string | null): Promise<string> {
    return sha256Encode(descriptionText(description))
}

/**
 * Decide, for items just persisted during ingest, which need a summary made
 * and which hold a summary of a description that has since changed. `existing`
 * is the items' state from before they were persisted (absent for new items).
 */
export async function planSummaries(
    items: ReadonlyArray<{guid: string, description: string | null}>,
    existing: ReadonlyMap<string, FeedItemFingerprint>,
): Promise<{tasks: SummarizeFeedItemTask[], stale: string[]}> {
    const tasks: SummarizeFeedItemTask[] = []
    const stale: string[] = []
    for (const item of items) {
        const storedHash = existing.get(item.guid)?.summary_source_hash ?? null
        const long = needsSummary(item.description)
        if (!long && storedHash === null) continue

        const hash = await summarySourceHash(item.description)
        if (hash === storedHash) continue

        if (storedHash !== null) stale.push(item.guid)
        if (long) tasks.push({type: 'summarize-feed-item', feedItemGuid: item.guid})
    }
    return {tasks, stale}
}

/** Drop summaries of descriptions that changed; previews show the new description until a new summary lands. */
export async function clearSummaries(db: D1Database, guids: readonly string[]) {
    for (const guid of guids) {
        await setFeedItemSummary(db, guid, null, null)
    }
}

/**
 * Tidy the model's reply: models sometimes wrap it in quotes or lead with a
 * label despite the prompt.
 */
export function cleanSummary(text: string): string {
    return text
        .trim()
        .replace(/^(?:\*\*)?(?:summary|preview)(?:\*\*)?\s*:\s*/i, '')
        .replace(/^["“'](.*)["”']$/s, '$1')
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * Generate and store the preview summary of one item (the
 * `summarize-feed-item` task). A no-op when the item is gone, its description
 * is short, or the stored summary was already made from this description.
 * Throws when the model fails, so the queue retries.
 */
export async function summarizeFeedItem(guid: string, env: Env) {
    const db = env.DB
    const item = await ServerFeedItem.get(db, guid)
    if (!item) return

    if (!needsSummary(item.description)) {
        if (item.summary_source_hash !== null) await setFeedItemSummary(db, guid, null, null)
        return
    }

    const hash = await summarySourceHash(item.description)
    if (item.summary !== null && item.summary_source_hash === hash) return

    const text = descriptionText(item.description).slice(0, MAX_INPUT_CHARS)
    const startedAt = Date.now()
    const result = await env.AI.run(SUMMARY_MODEL, {
        messages: [
            {role: 'system', content: SYSTEM_PROMPT},
            {role: 'user', content: `Title: ${item.title}\n\nDescription:\n${text}`},
        ],
        max_tokens: 200,
        temperature: 0.2,
    }) as {response?: unknown}

    const summary = typeof result.response === 'string' ? cleanSummary(result.response) : ''
    if (!summary) throw new Error('Summary model returned no text')

    // The description may have changed while the model ran; only store a
    // summary of what the row still holds.
    const current = await ServerFeedItem.get(db, guid)
    if (!current || await summarySourceHash(current.description) !== hash) return

    await setFeedItemSummary(db, guid, summary, hash)
    log.info('Summarised a feed item', {feedItemGuid: guid, inputChars: text.length, durationMs: Date.now() - startedAt})
}

if (import.meta.vitest) {
    const {describe, expect, it} = import.meta.vitest

    describe('cleanSummary', () => {
        it('strips labels, quotes and extra whitespace', () => {
            expect(cleanSummary('  Summary: An episode\n about  bees. ')).toBe('An episode about bees.')
            expect(cleanSummary('**Summary**: Bees.')).toBe('Bees.')
            expect(cleanSummary('"An episode about bees."')).toBe('An episode about bees.')
            expect(cleanSummary('“Bees.”')).toBe('Bees.')
        })

        it('leaves inner quotes alone', () => {
            expect(cleanSummary('The host reads "Bees" aloud.')).toBe('The host reads "Bees" aloud.')
        })
    })

    describe('needsSummary', () => {
        it('measures the plain text, not the markup', () => {
            const words = 'word '.repeat(130)
            expect(needsSummary(`<p>${words}</p>`)).toBe(true)
            expect(needsSummary(`<p class="${'x'.repeat(1000)}">short</p>`)).toBe(false)
            expect(needsSummary(null)).toBe(false)
        })
    })
}
