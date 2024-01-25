# Iris - an attempt to create an RSS aggregator

Due to the decommissioning of Google Podcasts in April 2024,
this is my attempt to create a replacement podcast aggregator.
While I'm at it, I might as well try to make a full RSS reader
(including blog posts that I usually follow via Feedly).

Features I care about:
- Listing podcast and blog episodes
- Tracking which episodes I have already watched/posts I have already read
- Complete lists of episodes/posts (many RSS feeds have a recency bias)
- Playback and queueing of episodes; displaying blog posts, comics, etc.

Features I don't care much about:
- "Explore" a.k.a. find other podcasts/blogs you may like (this isn't usually how I find things to follow)

## Development

```shell
npx wrangler pages dev --r2=RSS_CACHE_BUCKET --d1 DB=<database-id> -- npm run dev
```
