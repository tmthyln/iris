/**
 * Fetch a list of archived snapshots for a URL from the wayback machine.
 * Docs: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server
 *
 * @param url
 */
export async function fetchArchiveList(url: string) {
    const currentYear = new Date().getFullYear()
    const queryParams = new URLSearchParams([
        ['url', url],
        ['matchType', 'prefix'],
        ['output', 'json'],
        ['fl', 'timestamp,original,digest'],
        ['from', String(currentYear - 15)],
        ['filter', 'statuscode:200'],
        ['collapse', 'timestamp:8'],
        ['collapse', 'digest'],
    ])
    const response = await fetch(`https://web.archive.org/cdx/search/cdx?${queryParams}`, {
        headers: {
            'Accept': 'application/json',
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
