import path from 'node:path'
import {cloudflareTest, readD1Migrations} from '@cloudflare/vitest-plugin'
import vue from '@vitejs/plugin-vue'
import {defineConfig} from 'vitest/config'

// Two test projects:
//  - `node`: frontend and shared-lib tests, run in Node.
//  - `workers`: the Worker (src/services, src/service.ts), run inside workerd by
//    @cloudflare/vitest-plugin with the bindings from wrangler.toml — a real (local)
//    D1 database with the repo's migrations applied, R2 and the ItemQueue Durable
//    Object. Storage is isolated per test file.
// Coverage uses Istanbul because V8 coverage is not available inside workerd.
export default defineConfig({
    // The Vue plugin lets the coverage reporter transform untested .vue files.
    plugins: [vue()],
    test: {
        projects: [
            {
                extends: true,
                test: {
                    name: 'node',
                    // Frontend tests need a DOM; jsdom also provides localStorage etc.
                    environment: 'jsdom',
                    include: ['src/**/*.test.ts'],
                    includeSource: ['src/**/*.ts'],
                    exclude: ['**/node_modules/**', 'src/services/**', 'src/service.ts', 'src/service.test.ts'],
                },
            },
            {
                plugins: [
                    cloudflareTest(async () => ({
                        wrangler: {configPath: './wrangler.toml'},
                        // Tests never reach Cloudflare; the AI binding is replaced per test.
                        remoteBindings: false,
                        miniflare: {
                            // Test-only binding consumed by src/services/testing/setup.ts.
                            bindings: {
                                TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
                                // Deterministic push config regardless of the developer's .dev.vars.
                                VAPID_PUBLIC_KEY: 'test-vapid-public-key',
                                VAPID_PRIVATE_KEY: 'test-vapid-private-key',
                                VAPID_SUBJECT: 'mailto:test@example.com',
                            },
                        },
                    })),
                ],
                test: {
                    name: 'workers',
                    include: ['src/services/**/*.test.ts', 'src/service.test.ts'],
                    includeSource: ['src/services/**/*.ts'],
                    setupFiles: ['./src/services/testing/setup.ts'],
                },
            },
        ],
        coverage: {
            provider: 'istanbul',
            include: ['src/**/*.{ts,vue}'],
            exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/services/testing/**', 'src/testing/**'],
            reporter: ['text', 'html', 'lcov', 'json', 'json-summary'],
            reportOnFailure: true,
        },
    },
})
