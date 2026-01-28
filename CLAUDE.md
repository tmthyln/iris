# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Iris is a self-hosted RSS feed and podcast aggregator built as a replacement for Google Podcasts and Feedly. It's a full-stack TypeScript application with a Vue 3 frontend and Cloudflare Workers backend.

## Development Commands

```bash
# Start development server (frontend + backend with Cloudflare bindings)
npx wrangler pages dev --r2=RSS_CACHE_BUCKET -- npm run dev

# Run linting
npm run lint

# Run tests
npm run test

# Run tests with coverage
npm run coverage

# Type checking
npm run typecheck

# Build for production
npm run build

# Deploy to Cloudflare
npm run deploy

# Generate Cloudflare Worker types
npm run typegen

# Generate PWA assets
npm run generate:assets
```

## Architecture

### Frontend (src/)
- **Framework:** Vue 3 with Composition API
- **State Management:** Pinia stores in `src/stores/`
- **Routing:** Vue Router in `src/router/`
- **Styling:** Bulma CSS framework with SASS
- **Components:** Vue SFCs in `src/components/`

### Backend (Cloudflare Workers)
- **Entry Point:** `src/service.ts`
- **API Framework:** Hono for routing
- **API Routes:** `src/services/endpoints.ts`
- **Database Operations:** `src/services/crud.ts`
- **Business Logic:** `src/services/flows.ts`
- **Data Models:** `src/services/models.ts`

### Cloudflare Infrastructure
- **D1:** SQLite database for feeds and items
- **R2:** Bucket storage for RSS file cache
- **Queues:** Background processing for feed refresh
- **Durable Objects:** ItemQueue for persistent queue state
- **Cron:** Hourly scheduled feed refresh triggers

### Database
- Schema migrations in `migrations/`
- SQLite with full-text search support
- Models: Feed, FeedItem, FeedSource, FeedFile

## API Endpoints

```
GET  /api/feed              - List all feeds
POST /api/feed              - Add new feed
GET  /api/feed/:guid        - Get single feed
GET  /api/feed/:guid/feeditem - Get feed items
GET  /api/feeditem          - List recent/bookmarked items
GET  /api/feeditem/:guid    - Get single item
PATCH /api/feeditem/:guid   - Update item (bookmark, progress, finished)
GET  /api/queue             - Get queue items
```

## Configuration Files

- `wrangler.toml` - Cloudflare Workers configuration with staging and prod environments
- `vite.config.ts` - Build configuration including PWA, compression, and Cloudflare plugin
- `tsconfig.app.json` - Frontend TypeScript config
- `tsconfig.cf.json` - Cloudflare Workers TypeScript config

## Key Patterns

- RSS fetching and parsing utilities in `src/services/utils/files.ts`
- Data conversion between server and client models in `src/services/utils/conversion.ts`
- Frontend API client utilities in `src/client.ts`
- HTML content processing in `src/htmlproc.ts`