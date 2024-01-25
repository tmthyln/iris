/// <reference types="vitest" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import viteCompression from 'vite-plugin-compression'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        vue(),
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
})
