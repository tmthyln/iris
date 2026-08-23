# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Iris is a self-hosted RSS feed and podcast aggregator built as a replacement for Google Podcasts and Feedly. It's a full-stack TypeScript application with a Vue 3 frontend and Cloudflare Workers backend, all in one repo.

## Development Commands

```bash
# Start development server (frontend + backend with Cloudflare bindings, via @cloudflare/vite-plugin)
npm run dev

# Run linting (ESLint flat config, type-aware; warnings fail the run)
npm run lint

# Run tests (vitest, watch mode by default)
npm run test

# Run a single test file
npm run test -- src/services/utils/files.test.ts

# Run tests matching a name pattern
npm run test -- -t "parseRssText"

# Run tests once with coverage (text summary + coverage/ with html, lcov and json-summary)
npm run coverage

# Type checking — builds every tsconfig project (app, cf, sw, node) via `vue-tsc -b`
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

CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck` and `coverage` as three jobs on pushes to `main` and on pull requests; the test job posts a coverage table (job summary + PR comment) and uploads `coverage/` as an artifact. There is no build job — Cloudflare Builds builds and deploys.

## Architecture

### Monorepo Structure

Frontend and backend share `src/` but are **separated by TypeScript project references** (the root `tsconfig.json` is a solution file with `files: []`; `npm run typecheck` runs `vue-tsc -b` over all of them):
- `tsconfig.app.json` — Frontend: includes `src/**/*.ts` and `src/**/*.vue`, **excludes `src/services/**`, `src/service.ts`, `src/sw.ts` and `src/lib/**`**; *references* `tsconfig.cf.json` so `src/types.ts` can `import type {AppType}` from the Worker
- `tsconfig.cf.json` — Backend: includes `src/service.ts`, `src/services/**` (including tests), and `src/lib/**`. It is a composite project that emits declarations only, to `.tsbuild/cf/` (gitignored) — that is what the frontend project reads
- `tsconfig.sw.json` — Service worker: `src/sw.ts` only, with the `WebWorker` lib (neither DOM nor Workers runtime)
- `tsconfig.node.json` — `vite.config.ts`
- `src/lib/` — Shared utilities included in both app and cf tsconfigs (e.g., `conversion.ts` with `asBoolean()`, `asDate()`, `asStringList()`)
- `src/shims-vue.d.ts` declares `*.vue` modules for plain-TypeScript consumers (typescript-eslint); vue-tsc resolves the real SFCs and ignores it

### Frontend
- **Framework:** Vue 3 with Composition API
- **State Management:** Pinia stores in `src/stores/` (feeds, feeditems, queue, downloads) — mix of options and composition API styles, with `LoadingState` tracking ('unloaded' | 'loading' | 'loaded')
- **Routing:** Vue Router in `src/router/`
- **Styling:** Bulma CSS framework with SASS
- **API Client:** `src/client.ts` — Hono RPC client (`hc<AppType>`) wrapped in `request()`, which returns an `ApiResult<T>` (`{ok: true, data}` / `{ok: false, status, error}`) with timeouts and the Access 401 handling. Path params are `encodeURIComponent`-ed explicitly (hc does not encode, and GUIDs are often URLs)

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

### Type Layers

Data flows through distinct type layers:

1. **Raw types** (`src/services/models.ts`: `RawFeed`, `RawFeedItem`, etc.) — direct D1 column mapping, SQLite types
2. **Server models** (`ServerFeed`, `ServerFeedItem`, etc.) — normalized types with methods (`.persistTo()`, `.get()`), used within Workers
3. **Client models** (`ClientFeed`, `ClientFeedItem`, `ClientFeedItemPreview`) — serialization-ready subset that handlers pass to `c.json()`
4. **Frontend types** (`src/types.ts`: `Feed`, `FeedItem`, `FeedItemPreview`, `FeedUpdate`, …) — **derived, not hand-written**: `InferResponseType`/`InferRequestType` over `AppType` (the Hono app's type exported from `endpoints.ts`). Dates arrive as strings because Hono's `JSONParsed` models serialisation. Changing a Client model or a validator changes the frontend types; a disagreeing store or component then fails `npm run typecheck`

Rules that keep the inference working (`src/services/endpoints.ts`):
- Routes are **chained** (`new Hono<Bindings>().get(...).post(...)`) per domain and composed with `app.route()`; a standalone `app.get(...)` statement contributes nothing to `AppType`
- Handlers return `c.json(value, status)` / `c.body(null, status)` with an **explicit status**, never `Response.json` or `new Response` (the media proxy is the one exception); errors go through `apiError(c, status, message)`
- Request bodies and query strings are declared with `hono/validator` (hand-written validators, no schema library); handlers read them with `c.req.valid('json' | 'query')`. Annotate a validator's return type when keys should be optional for the client
- Response values must come from typed functions in `crud.ts`/`models.ts`, not inline `c.env.DB` queries: typescript-eslint type-checks `endpoints.ts` under the frontend's compiler options when it follows `AppType`, where the global `Env` is unresolved, and an inline query would make that route's response type unresolvable for lint
- The frontend only ever `import type`s from `src/services/` (enforced by `@typescript-eslint/consistent-type-imports`), so no Worker code reaches the browser bundle

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
- ESLint runs type-aware (`recommendedTypeChecked` with `projectService`), so every linted `.ts`/`.vue` file must belong to one of the tsconfig projects. Intentional fire-and-forget promises are written `void promise`; `eslint --fix` is safe for the Vue template style rules
- Parsed-JSON / untyped-parser values are cast at the boundary (`await c.req.json() as {…}`, `JSON.parse(x) as T`) rather than left as `any`
- Vitest supports in-source testing via `import.meta.vitest`
- Shared conversion utilities live in `src/lib/` (not `src/services/utils/`)
- Frontend API client in `src/client.ts` is a plain object of async methods over the Hono RPC client; add a method there rather than calling `apiFetch` with a hand-written path
- Pinia stores use cache-first approach for feed items and callback queues for lazy loading