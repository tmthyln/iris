import {FailedFetchResult, SuccessfulFetchResult} from "./types";

const RSS_ACCEPT_MIMES = [
    'application/rss+xml',
    'application/rdf+xml;q=0.8',
    'application/atom+xml;q=0.6',
    'application/xml;q=0.4',
    'text/xml;q=0.4',
].join(', ')

export async function fetchRss(url): Promise<SuccessfulFetchResult | FailedFetchResult> {
    const response = await fetch(url, {
        headers: {
            'Accept': RSS_ACCEPT_MIMES,
        },
    });

    if (response.ok) {
        const text = await response.text()
        if (text.substring(0, 2000).toLowerCase().indexOf('<!doctype html>') < 0) {
            return {
                status: 'success',
                timestamp: response.headers.get('date'),
                inputUrl: url,
                requestUrl: url,
                text,
            }
        }
    }

    const htmlResponse = await fetch(url, {
        headers: {
            'Accept': 'text/html',
        },
    })

    if (htmlResponse.ok) {
        // TODO try to extract the actual rss url from head info
    }

    return {
        status: 'failure',
        timestamp: response.headers.get('date'),
        inputUrl: url,
    }
}

/**
 * Fetch a list of archived snapshots for a URL from the wayback machine.
 * Docs: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server
 *
 * @param url
 */
export async function fetchArchiveList(url) {
    const currentYear = new Date().getFullYear()
    const queryParams = [
        `url=${encodeURIComponent(url)}`,
        `matchType=prefix`,
        `output=json`,
        `fl=timestamp,mimetype,statuscode,digest,length`,
        `from=${currentYear - 15}`,
        `filter=statuscode:200`,
        `filter=!mimetype:text/html`,
        `collapse=timestamp:8`,
        `collapse=digest`,
    ].join('&')
    const response = await fetch(`https://web.archive.org/cdx/search/cdx?${queryParams}`, {
        headers: {
            'Accept': 'application/json',
        },
    })

    if (response.ok) {
        const data = await response.json()
        return data.map(row => ({
            timestamp: parseInt(row[0]),
            mimetype: row[1],
            statuscode: parseInt(row[2]),
            digest: row[3],
            length: parseInt(row[4]),
        }))
    } else {
        return []
    }
}
