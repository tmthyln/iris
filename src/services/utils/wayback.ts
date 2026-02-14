import {FETCH_USER_AGENT} from "./files";

/**
 * Fetch a list of archived snapshots for a URL from the wayback machine.
 * Docs: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server
 *
 * @param url
 */
export async function fetchArchiveList(url: string) {
    const currentYear = new Date().getFullYear()
    const encodedUrl = encodeURIComponent(url)
    const requestUrl = `https://web.archive.org/cdx/search/cdx?url=${encodedUrl}&matchType=prefix&output=json&fl=timestamp,original,digest&from=${currentYear - 15}&filter=statuscode:200&collapse=timestamp:8&collapse=digest`
    const response = await fetch(requestUrl, {
        headers: {
            'User-Agent': FETCH_USER_AGENT,
        },
    })

    if (response.ok) {
        const data = await response.json() as [string, string, string][]
        return data.slice(1).map(row => ({
            timestamp: parseInt(row[0]),
            original: row[1],
            digest: row[2],
        }))
    } else {
        return []
    }
}

export function waybackSnapshotUrl(timestamp: number, original: string) {
    return `https://web.archive.org/web/${timestamp}id_/${original}`
}
