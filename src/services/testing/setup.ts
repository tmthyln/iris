import {applyD1Migrations} from 'cloudflare:test'
import {env} from 'cloudflare:workers'

// Storage is isolated per test file, so every file starts from an empty D1
// database with the repo's migrations applied.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
