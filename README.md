# Iris - a simple opinionated feed aggregator

Due to the decommissioning of Google Podcasts in April 2024,
this is my attempt to create a replacement podcast aggregator.
While I'm at it, I might as well try to make a full RSS reader
(including blog posts that I usually follow via Feedly).

Features I care about:
- Listing podcast and blog episodes
- Tracking which episodes I have already watched/posts I have already read
- Complete lists of episodes/posts (many RSS feeds are only an incomplete set)
- Playback and queueing of episodes; displaying blog posts, comics, etc.

Features I don't care much about:
- "Explore" a.k.a. find other podcasts/blogs you may like (this isn't usually how I find things to follow)

## Development

```shell
npx wrangler pages dev --r2=RSS_CACHE_BUCKET --d1 DB=<database-id> -- npm run dev
```

## Deployment

1. Get this repo.
2. Set up Cloudflare Pages to build and deploy on changes to the repo.
3. Set up D1 databases for prod and preview.
4. Set up R2 buckets for prod and preview.
5. Adding D1 and R2 bindings to Pages Functions.
6. Set up Cloudflare Zero Trust protection to gateway access to the webapp (optional).
7. Visit the site for the first time.
8. Deploy the updater worker and bind the D1 databases and R2 buckets.

## Pricing

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

### Pages

Pages is free to build and host if you don't build too frequently
(which should be the case in a production deployment). 
(The domain is not, but I already pay for that separately
and is not a required component.)
