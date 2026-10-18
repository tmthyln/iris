// A plain product token, as feed fetchers send: anti-bot filters (e.g. SiteGround's) 403 a
// `Mozilla/5.0 (compatible; …)` string that claims to be a browser but isn't one.
export const FETCH_USER_AGENT = 'Iris/1.0 (+https://github.com/tmthyln/iris)'

export { sha256Encode } from './crypto'
export { fetchRssFile } from './fetch-rss'
export { parseRssText, computeFeedItemContentHash } from './parse-rss'
export type { ChannelData, ChannelItemData } from './parse-rss'
export { fetchArchiveList, waybackSnapshotUrl } from './wayback'
