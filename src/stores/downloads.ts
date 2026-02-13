import {defineStore} from "pinia";
import {reactive, ref} from "vue";
import type {FeedItemPreview} from "../types.ts";

/* ── Types ── */

type DownloadStatus =
    | 'idle'
    | { state: 'downloading'; progress: number; abortController: AbortController }
    | { state: 'downloaded'; size: number; downloadedAt: string }
    | { state: 'error'; message: string }

interface DownloadRecord {
    guid: string
    blob: Blob
    enclosure_url: string
    enclosure_type: string | null
    size: number
    downloaded_at: string
}

/* ── IndexedDB helpers ── */

const DB_NAME = 'iris-downloads'
const DB_VERSION = 1
const STORE_NAME = 'audio'

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, {keyPath: 'guid'})
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

function dbPut(db: IDBDatabase, record: DownloadRecord): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        tx.objectStore(STORE_NAME).put(record)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}

function dbGet(db: IDBDatabase, guid: string): Promise<DownloadRecord | undefined> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const request = tx.objectStore(STORE_NAME).get(guid)
        request.onsuccess = () => resolve(request.result as DownloadRecord | undefined)
        request.onerror = () => reject(request.error)
    })
}

function dbDelete(db: IDBDatabase, guid: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        tx.objectStore(STORE_NAME).delete(guid)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}

/** Read all records' metadata without loading blobs into memory. */
function dbGetAllMeta(db: IDBDatabase): Promise<{ guid: string; size: number; downloadedAt: string }[]> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const store = tx.objectStore(STORE_NAME)
        const request = store.openCursor()
        const results: { guid: string; size: number; downloadedAt: string }[] = []
        request.onsuccess = () => {
            const cursor = request.result
            if (cursor) {
                const {guid, size, downloaded_at} = cursor.value as DownloadRecord
                results.push({guid, size, downloadedAt: downloaded_at})
                cursor.continue()
            } else {
                resolve(results)
            }
        }
        request.onerror = () => reject(request.error)
    })
}

/* ── Pinia Store ── */

export const useDownloadStore = defineStore('downloads', () => {
    const statuses = reactive<Record<string, DownloadStatus>>({})
    const blobUrls = reactive<Record<string, string>>({})
    const totalStorageUsed = ref(0)

    let db: IDBDatabase | null = null

    async function init() {
        try {
            db = await openDb()
            const metas = await dbGetAllMeta(db)
            let total = 0
            for (const meta of metas) {
                statuses[meta.guid] = {state: 'downloaded', size: meta.size, downloadedAt: meta.downloadedAt}
                total += meta.size
            }
            totalStorageUsed.value = total
            navigator.storage?.persist?.()
        } catch (_err) {
            console.error('Failed to initialize download store:', _err)
        }
    }

    async function downloadItem(item: FeedItemPreview) {
        if (!item.enclosure_url || !db) return

        const abortController = new AbortController()
        statuses[item.guid] = {state: 'downloading', progress: 0, abortController}

        try {
            // Check storage quota before downloading
            if (navigator.storage?.estimate) {
                const estimate = await navigator.storage.estimate()
                if (estimate.quota && estimate.usage) {
                    const remaining = estimate.quota - estimate.usage
                    // Bail if less than 50MB remaining
                    if (remaining < 50 * 1024 * 1024) {
                        statuses[item.guid] = {state: 'error', message: 'Insufficient storage space'}
                        return
                    }
                }
            }

            const response = await fetch(item.enclosure_url, {signal: abortController.signal})
            if (!response.ok) throw new Error(`HTTP ${response.status}`)

            const contentLength = Number(response.headers.get('content-length')) || 0
            const reader = response.body?.getReader()
            if (!reader) throw new Error('No response body')

            const chunks: Uint8Array[] = []
            let received = 0

            while (true) {
                const {done, value} = await reader.read()
                if (done) break
                chunks.push(value)
                received += value.byteLength
                if (contentLength > 0) {
                    const status = statuses[item.guid]
                    if (typeof status === 'object' && status.state === 'downloading') {
                        status.progress = received / contentLength
                    }
                }
            }

            const blob = new Blob(chunks, {type: item.enclosure_type ?? 'audio/mpeg'})
            const now = new Date().toISOString()
            await dbPut(db, {
                guid: item.guid,
                blob,
                enclosure_url: item.enclosure_url,
                enclosure_type: item.enclosure_type,
                size: blob.size,
                downloaded_at: now,
            })

            statuses[item.guid] = {state: 'downloaded', size: blob.size, downloadedAt: now}
            totalStorageUsed.value += blob.size

            // Pre-create the blob URL
            blobUrls[item.guid] = URL.createObjectURL(blob)
        } catch (err) {
            if ((err as Error).name === 'AbortError') {
                statuses[item.guid] = 'idle'
            } else {
                statuses[item.guid] = {state: 'error', message: (err as Error).message}
            }
        }
    }

    function cancelDownload(guid: string) {
        const status = statuses[guid]
        if (typeof status === 'object' && status.state === 'downloading') {
            status.abortController.abort()
        }
    }

    async function deleteDownload(guid: string) {
        if (!db) return
        try {
            const status = statuses[guid]
            if (typeof status === 'object' && status.state === 'downloaded') {
                totalStorageUsed.value -= status.size
            }
            await dbDelete(db, guid)
            if (blobUrls[guid]) {
                URL.revokeObjectURL(blobUrls[guid])
                delete blobUrls[guid]
            }
            statuses[guid] = 'idle'
        } catch (_err) {
            console.error('Failed to delete download:', _err)
        }
    }

    async function getLocalUrl(guid: string): Promise<string | null> {
        if (blobUrls[guid]) return blobUrls[guid]
        if (!db) return null
        const record = await dbGet(db, guid)
        if (!record) return null
        const url = URL.createObjectURL(record.blob)
        blobUrls[guid] = url
        return url
    }

    function isDownloaded(guid: string): boolean {
        const status = statuses[guid]
        return typeof status === 'object' && status.state === 'downloaded'
    }

    function getStatus(guid: string): DownloadStatus {
        return statuses[guid] ?? 'idle'
    }

    return {
        statuses,
        blobUrls,
        totalStorageUsed,
        init,
        downloadItem,
        cancelDownload,
        deleteDownload,
        getLocalUrl,
        isDownloaded,
        getStatus,
    }
})
