/// <reference types="vitest" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import viteCompression from 'vite-plugin-compression'
import { VitePWA as vitePWA } from "vite-plugin-pwa";
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vitejs.dev/config/
export default defineConfig({
    build: {
        sourcemap: true,
    },
    plugins: [
        vue(),
        vueDevTools(),
        vitePWA({
            registerType: 'autoUpdate',
            workbox: {
                globPatterns: ['**/*.{js,css,html,svg}'],
            },
            manifest: {
                name: 'Iris Aggregator',
                short_name: 'Iris',
                description: 'An aggregator for both blog and podcast feeds',
                theme_color: '#35e871',
                icons: [
                    {
                        "src": "pwa-64x64.png",
                        "sizes": "64x64",
                        "type": "image/png"
                    },
                    {
                        "src": "pwa-192x192.png",
                        "sizes": "192x192",
                        "type": "image/png"
                    },
                    {
                        "src": "pwa-512x512.png",
                        "sizes": "512x512",
                        "type": "image/png"
                    },
                    {
                        "src": "maskable-icon-512x512.png",
                        "sizes": "512x512",
                        "type": "image/png",
                        "purpose": "maskable"
                    },
                ],
            },
        }),
        viteCompression({
            algorithm: 'gzip',
        }),
        viteCompression({
            algorithm: 'brotliCompress',
            ext: 'br',
        }),
    ],
    test: {
        includeSource: [
            'src/**/*.{js,ts}',
            'functions/**/*.{js,ts}',
        ],
    },
    define: {
        'import.meta.vitest': 'undefined',
    },
    server: {
        proxy: {
            '/api': {
                target: 'http://localhost:8345',
            },
        },
    },
})
