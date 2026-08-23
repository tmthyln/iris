# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Iris is a self-hosted RSS feed and podcast aggregator built as a replacement for Google Podcasts and Feedly. It's a full-stack TypeScript application with a Vue 3 frontend and Cloudflare Workers backend, all in one repo.

## Development Commands

```bash
# Start development server (frontend + backend with Cloudflare bindings, via @cloudflare/vite-plugin)
npm run dev

# Run linting (ESLint 9 flat config)
npm run lint

# Run tests (vitest, watch mode by default)
npm run test

# Run a single test file
npm run test -- src/services/utils/files.test.ts

# Run tests matching a name pattern
npm run test -- -t "parseRssText"

# Run tests with coverage
npm run coverage

# Type checking
npm run typecheck

# Build for production
npm run build

# Deploy to Cloudflare (production; run `npm run build` first)
npm run deploy

# Create/update a Workers Preview (run `npm run build` first; name defaults to the git branch)
npm run preview
npm run preview -- --name staging

# Generate Cloudflare Worker types (worker-configuration.d.ts)
npm run typegen

# Apply D1 migrations (production / staging DB used by Previews)
wrangler d1 migrations apply DB --remote
wrangler d1 migrations apply DB --remote --preview
```

## Architecture

### Monorepo Structure

Frontend and backend share `src/` but are **separated by TypeScript project references**:
- `tsconfig.app.json` — Frontend: includes `src/**/*.ts` and `src/**/*.vue`, **excludes `src/services/*` and `src/service.ts`**
- `tsconfig.cf.json` — Backend: includes `src/service.ts`, `src/services/*`, and `src/lib/*`
- `src/lib/` — Shared utilities included in both tsconfigs (e.g., `conversion.ts` with `asBoolean()`, `asDate()`, `asStringList()`)

### Frontend
- **Framework:** Vue 3 with Composition API
- **State Management:** Pinia stores in `src/stores/` (feeds, feeditems, queue, downloads) — mix of options and composition API styles, with `LoadingState` tracking ('unloaded' | 'loading' | 'loaded')
- **Routing:** Vue Router in `src/router/`
- **Styling:** Bulma CSS framework with SASS
- **API Client:** `src/client.ts` — pure data fetching layer using fetch API, returns typed data or `null` on error

### Dev Server
- `npm run dev` runs `vite dev`; `@cloudflare/vite-plugin` (in `vite.config.ts`) runs the Worker inside the Vite dev server with real bindings from `wrangler.toml`, so the single Vite origin (port 5173) serves both the frontend and `/api/*` — no separate `wrangler dev` process
- The plugin is skipped under Vitest (`!process.env.VITEST && cloudflare()`)
- Local dev uses the top-level (production-named) bindings, but D1/R2/Queues/Durable Objects are all local Miniflare state under `.wrangler/state/`; only `AI` is remote
- `access.dev` at the top level of `wrangler.toml` simulates a Cloudflare Access identity locally (`ctx.access` in the Worker); `aud` is the Access application's audience tag; the Worker doesn't read it yet
- Production build/deploy is two steps: `vite build` to `dist/`, then `wrangler deploy` (the plugin writes `dist/<worker>/wrangler.json` and a `.wrangler/deploy/config.json` redirect, which is what `wrangler deploy`/`wrangler preview` pick up)
- Previews: `vite build` then `wrangler preview [--name <name>]` deploys the checkout as a Preview at `<name>.iris.timothylin.me` with the `[previews]` bindings (staging D1/R2/Queue). Cron and the queue consumer don't run in Previews. Previews are the replacement for the old `staging` Wrangler environment; there is no `[env.*]` config anymore

### Backend (Cloudflare Workers)
- **Entry Point:** `src/service.ts` — exports `fetch` (Hono app), `queue` (consumer), and `scheduled` (cron) handlers
- **API Framework:** Hono for routing (`src/services/endpoints.ts`)
- **Request flow:** `endpoints.ts` → `flows.ts` (business logic) → `crud.ts` (DB ops) → `models.ts` (entities) → D1/R2
- **Background processing:** Hourly cron → `scheduled()` → sends feed refresh tasks to Queue → `queue()` consumer → `refreshFeed()` flow
- **Durable Objects:** `ItemQueue` in `src/services/queue.ts` — persistent queue with SQL storage for podcast playback queue

### Three-Tier Type System

Data flows through distinct type layers:

1. **Raw types** (`src/services/models.ts`: `RawFeed`, `RawFeedItem`, etc.) — direct D1 column mapping, SQLite types
2. **Server models** (`ServerFeed`, `ServerFeedItem`, etc.) — normalized types with methods (`.persistTo()`, `.get()`), used within Workers
3. **Client models** (`ClientFeed`, `ClientFeedItem`, `ClientFeedItemPreview`) — serialization-ready subset for API responses
4. **Frontend interfaces** (`src/types.ts`: `Feed`, `FeedItem`, `FeedItemPreview`) — plain interfaces with string dates, used by Vue/Pinia

### Cloudflare Infrastructure
- **D1:** SQLite database (STRICT mode, migrations in `migrations/`)
- **R2:** Bucket storage for RSS file cache
- **Queues:** Background feed refresh processing
- **Durable Objects:** ItemQueue for persistent playback queue state
- **Cron:** Hourly scheduled feed refresh at `:17` (production only — Previews have no cron)
- **Environments:** Production is the top level of `wrangler.toml` (Worker `iris-prod`); Workers Previews use the `[previews]` block with separate `-staging` D1/R2/Queue resources. No Wrangler `[env.*]` blocks

### Authentication

The API has **no in-app authentication by design** (#205). Production and every Preview hostname (`*.iris.timothylin.me`) sit behind a Cloudflare Access application, which handles login before requests ever reach the Worker. Consequences:

- Do not add per-endpoint auth checks, tokens, or session handling to the Worker — access control is Access's job.
- Endpoints reachable without Access (none currently) must be treated as public. Keep `workers_dev`/`preview_urls` off in `wrangler.toml` — `workers.dev` hostnames would bypass Access. The push-subscription endpoints additionally validate input and cap table growth because they were written before Access was in place.
- Web push delivery is unaffected: notifications arrive via the browser push service, not same-origin fetches.
- Local dev (`npm run dev` / wrangler) has no Access in front of it — everything is open on localhost, which is expected.
- Expired Access sessions: `src/client.ts` sends `X-Requested-With: XMLHttpRequest` on every API call so Access answers 401 instead of redirecting to its (cross-origin) login page, and a 401 triggers a document navigation with a throwaway `?reauth=` param (stripped by the router) to log in again. Frontend code must call the API through `client.ts` (`request`/`apiFetch`), and the Worker must never return 401 itself.

### Database
- Schema migrations in `migrations/`
- SQLite with full-text search support
- Models: Feed, FeedItem, FeedSource, FeedFile

### RSS Parsing
- Uses `fast-xml-parser` in `src/services/utils/files.ts`
- Handles both blog and podcast feeds (podcast detection via iTunes namespace)
- Podcast-specific fields: season, episode, duration, enclosure

## API Endpoints

```
GET    /api/feed                  - List all feeds
POST   /api/feed                  - Add new feed
GET    /api/feed/:guid            - Get single feed
GET    /api/feed/:guid/feeditem   - Get feed items
GET    /api/feeditem              - List recent/bookmarked items
GET    /api/feeditem/:guid        - Get single item
PATCH  /api/feeditem/:guid        - Update item (bookmark, progress, finished)
GET    /api/queue                 - Get queue items
POST   /api/queue                 - Add to queue
PATCH  /api/queue                 - Move queue item
DELETE /api/queue                 - Clear queue
DELETE /api/queue/:guid           - Remove from queue
POST   /api/command/refresh-all-feeds - Trigger manual refresh
```

## Key Patterns

- Unused variables should be prefixed with `_` (ESLint rule) — but this does not apply to destructured bindings; omit them instead
- Short-circuit expressions allowed (`x && doSomething()`)
- Vitest supports in-source testing via `import.meta.vitest`
- Shared conversion utilities live in `src/lib/` (not `src/services/utils/`)
- Frontend API client in `src/client.ts` is a plain object with async methods, no library dependencies
- Pinia stores use cache-first approach for feed items and callback queues for lazy loading