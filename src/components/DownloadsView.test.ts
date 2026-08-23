import {describe, expect, it} from 'vitest'
import {useDownloadStore} from '../stores/downloads.ts'
import {makeItem, mountApp} from '../testing/helpers.ts'
import DownloadsView from './DownloadsView.vue'

function seedDownload(store: ReturnType<typeof useDownloadStore>, size: number, downloadedAt: string) {
    const item = makeItem({enclosure_url: 'https://example.com/a.mp3'})
    store.downloadedItems[item.guid] = item
    store.statuses[item.guid] = {state: 'downloaded', size, downloadedAt}
    store.totalStorageUsed += size
    return item
}

describe('DownloadsView', () => {
    it('shows an empty state when nothing is downloaded', async () => {
        const {wrapper} = await mountApp(DownloadsView)
        expect(wrapper.text()).toContain('No downloaded items.')
    })

    it('lists downloads newest first with size and date', async () => {
        const {wrapper} = await mountApp(DownloadsView)
        const store = useDownloadStore()
        const older = seedDownload(store, 512 * 1024, '2024-01-05T12:00:00Z')
        const newer = seedDownload(store, 3.5 * 1024 * 1024, '2024-02-10T12:00:00Z')
        await wrapper.vm.$nextTick()

        const boxes = wrapper.findAll('.box')
        expect(boxes.map(box => box.find('a').text())).toEqual([newer.title, older.title])
        expect(boxes[0].text()).toContain('3.5 MB')
        expect(boxes[1].text()).toContain('512 KB')
        expect(boxes[0].find('a').attributes('href')).toBe(`/subscriptions/item/${newer.guid}`)
    })

    it('shows the total storage used', async () => {
        const {wrapper} = await mountApp(DownloadsView)
        seedDownload(useDownloadStore(), 10 * 1024 * 1024, '2024-01-05T12:00:00Z')
        await wrapper.vm.$nextTick()
        expect(wrapper.text()).toContain('10.0 MB used')
    })
})
