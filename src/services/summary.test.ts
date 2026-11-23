import {env} from 'cloudflare:workers'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {setFeedItemSummary} from './crud'
import {ClientFeedItemPreview, ServerFeedItem} from './models'
import {planSummaries, SUMMARY_MODEL, summarizeFeedItem, summarySourceHash} from './summary'
import {runTask} from './tasks'
import {resetStorage, seedFeed, seedFeedItem, testEnv} from './testing/fixtures'

const db = env.DB
const LONG = `<p>${'An episode about bees and the people who keep them. '.repeat(20)}</p>`

beforeEach(async () => {
    await resetStorage()
    await seedFeed({guid: 'feed-a'})
})
afterEach(() => vi.restoreAllMocks())

function fakeAi(reply: unknown = {response: 'Summary: A show about bees.'}) {
    const run = vi.fn((_model: string, _input: unknown) =>
        reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply))
    return {ai: {run}, env: testEnv({AI: {run} as unknown as Ai}).env}
}

async function stored(guid: string) {
    return db.prepare('SELECT summary, summary_source_hash FROM feed_item WHERE guid = ?')
        .bind(guid).first<{summary: string | null, summary_source_hash: string | null}>()
}

describe('summarizeFeedItem', () => {
    test('stores a cleaned summary with the hash of the description', async () => {
        await seedFeedItem('feed-a', {guid: 'ep', title: 'Bees', description: LONG})
        const {ai, env: testEnvironment} = fakeAi()

        await runTask({type: 'summarize-feed-item', feedItemGuid: 'ep'}, testEnvironment)

        expect(ai.run).toHaveBeenCalledOnce()
        const [model, input] = ai.run.mock.calls[0]
        expect(model).toBe(SUMMARY_MODEL)
        const {messages} = input as {messages: {role: string, content: string}[]}
        expect(messages[1].content).toContain('Title: Bees')
        // The model gets plain text, not markup.
        expect(messages[1].content).not.toContain('<p>')

        expect(await stored('ep')).toEqual({summary: 'A show about bees.', summary_source_hash: await summarySourceHash(LONG)})
        const preview = new ClientFeedItemPreview((await ServerFeedItem.get(db, 'ep'))!)
        expect(preview.summary).toBe('A show about bees.')
    })

    test('does not call the model for a short description, an up-to-date summary or a missing item', async () => {
        await seedFeedItem('feed-a', {guid: 'short', description: '<p>Brief.</p>'})
        await seedFeedItem('feed-a', {guid: 'done', description: LONG})
        await setFeedItemSummary(db, 'done', 'Existing.', await summarySourceHash(LONG))
        const {ai, env: testEnvironment} = fakeAi()

        await summarizeFeedItem('short', testEnvironment)
        await summarizeFeedItem('done', testEnvironment)
        await summarizeFeedItem('missing', testEnvironment)

        expect(ai.run).not.toHaveBeenCalled()
        expect(await stored('done')).toMatchObject({summary: 'Existing.'})
    })

    test('clears a summary left on a description that is now short', async () => {
        await seedFeedItem('feed-a', {guid: 'ep', description: '<p>Brief.</p>'})
        await setFeedItemSummary(db, 'ep', 'Old.', 'old-hash')
        const {env: testEnvironment} = fakeAi()

        await summarizeFeedItem('ep', testEnvironment)

        expect(await stored('ep')).toEqual({summary: null, summary_source_hash: null})
    })

    test('throws (so the queue retries) when the model fails or returns nothing', async () => {
        await seedFeedItem('feed-a', {guid: 'ep', description: LONG})

        await expect(summarizeFeedItem('ep', fakeAi(new Error('AI down')).env)).rejects.toThrow('AI down')
        await expect(summarizeFeedItem('ep', fakeAi({response: '  '}).env)).rejects.toThrow('no text')
        expect(await stored('ep')).toEqual({summary: null, summary_source_hash: null})
    })
})

describe('planSummaries', () => {
    test('queues new long items, skips short ones and flags summaries of changed descriptions', async () => {
        const hash = await summarySourceHash(LONG)
        const existing = new Map([
            ['kept', {date: null, content_hash: null, summary_source_hash: hash}],
            ['changed-long', {date: null, content_hash: null, summary_source_hash: 'old'}],
            ['changed-short', {date: null, content_hash: null, summary_source_hash: 'old'}],
        ])

        const plan = await planSummaries([
            {guid: 'new-long', description: LONG},
            {guid: 'new-short', description: 'brief'},
            {guid: 'kept', description: LONG},
            {guid: 'changed-long', description: `${LONG} more`},
            {guid: 'changed-short', description: 'brief'},
        ], existing)

        expect(plan.tasks.map(t => t.feedItemGuid)).toEqual(['new-long', 'changed-long'])
        expect(plan.stale).toEqual(['changed-long', 'changed-short'])
    })
})
