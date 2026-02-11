# Iris

A self-hosted RSS feed and podcast aggregator, built as a replacement for Google Podcasts and Feedly.

Due to the decommissioning of Google Podcasts in April 2024,
I needed a replacement podcast aggregator.
While I'm at it, I thought I might as well try to make a full RSS reader
(including blog posts that I usually follow via Feedly)
to keep them all in one place.

Features I care about:
- Listing podcast and blog episodes
- Tracking which episodes I have already watched/posts I have already read
- Complete lists of episodes/posts (many RSS feeds are only an incomplete set)
- Playback and queueing of episodes; displaying blog posts, comics, etc.

Features I don't care much about:
- "Explore" a.k.a. find other podcasts/blogs you may like (this isn't usually how I find things to follow)


## Features

- Subscribe to RSS/Atom feeds for both blogs and podcasts
- Track read/listened status across all feed items
- Full episode archive support (fetches complete history, not just the latest RSS window)
- Audio playback with persistent queue and drag-to-reorder
- Bookmark items for quick access
- Organize feeds into categories
- Search and command palette (press `/` for commands, `?` for search)
- Full-text search across feeds and items
- Dark mode support (follows system preference)
- Installable as a PWA


## Tech Stack

- **Frontend:** Vue 3 (Composition API), Pinia, Vue Router, Bulma CSS
- **Backend:** Cloudflare Workers with Hono
- **Database:** Cloudflare D1 (SQLite)
- **Storage:** Cloudflare R2 (RSS file cache)
- **Background Jobs:** Cloudflare Queues + Cron Triggers (hourly feed refresh)
- **Durable Objects:** Persistent podcast playback queue
- **Build:** Vite, TypeScript, ESLint 9, Vitest


## Development

```bash
# Install dependencies
npm install

# Start development server (frontend + backend with Cloudflare bindings)
npm run dev

# Run linting
npm run lint

# Run tests
npm run test

# Type checking
npm run typecheck

# Build for production
npm run build
```


## Deployment

Iris is deployed as a Cloudflare Worker with static assets. The `wrangler.toml` defines two environments: `staging` and `prod`, each with separate D1 databases, R2 buckets, and Queues.

1. Clone this repo.
2. Configure Cloudflare resources: D1 database, R2 bucket, Queue, and Durable Object namespace.
3. Update `wrangler.toml` with your resource bindings.
4. Apply D1 migrations:
   ```bash
   wrangler d1 migrations apply DB --env staging
   wrangler d1 migrations apply DB --env prod
   ```
5. Deploy:
   ```bash
   npm run deploy
   ```
6. Optionally set up Cloudflare Zero Trust to restrict access.


## Hosting Cost

The cost for hosting the code and data is lower than I originally guessed.
There are multiple Cloudflare services used with pricing models:
- D1 (currently in beta)
- R2 bucket storage
- Workers/Functions
- Pages

These calculations are all done assuming this is the only project being run on this account.
Period of one year.

| Service | Line Item   | Est. Quantity  | Est. Yearly Cost |
|:--------|:------------|----------------|-----------------:|
| R2      | Storage     | 43.8 GB-months |           $0.657 |
| R2      | Class A Ops | 182,500 ops    |         $0.82125 |
| R2      | Class B Ops | 182,500 ops    |          $0.0657 |
| Pages   | Hosting     | Continuous     |            $0.00 |

Of course, the feature set is different,
but here are some price comparisons with RSS and podcast aggregators
(the ones that I'm trying to replace):
- Iris (this system!): $0.13/month for the first year, $0.62/month at year 10
- Feedly Pro: $6/month
- Feedly Pro+: $8.25/month for the first year, $12/month after that
- Spotify Premium Individual: $10.99/month
- Spotify Premium Family: $2.83/person/month
- Apple Podcasts: the price of obtaining an Apple product and selling your soul

### R2

R2 bucket storage is used to cache raw RSS feed files.
Exact duplicate files are not stored.
A typical large RSS feed file among those I use and checked is about 100KB.
Supposing I have 100 different podcasts which update their RSS feed once daily,
this would be 3.65 GB a year.
This is well within the free plan limits (and this is an overestimate, at least for me).

At the billable level, this is 43.8 GB-months of storage per year.
At current [R2 storage rates](https://developers.cloudflare.com/r2/pricing),
this is $0.657 *per year*.
(Storage costs will go up at a rate of $0.657/year.)

For update actions done by the worker (fetching RSS feed updates in the background),
an overestimate is 5 Class A operations/podcast and 5 Class B operations/podcast
(this is a *significant* overestimation).
Using the above update frequencies, this results in 182,500 operations of each type/year,
which is within the free plan limits.
Assuming billable resources, this would cost
$0.82125/year for the Class A operations and $0.0657/year for Class B operations.

The website frontend does not make any calls that touch R2.

### Workers

The feed updater worker runs once an hour and
refreshes feeds from their active feed sources.
Not every feed will be fetched hourly
(depending on an estimate of each feed's update frequency),
and most feeds will not have updates every time they're fetched.

### D1
