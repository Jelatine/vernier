import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolveVersion } from './scripts/version.mjs'

// One version for main, preload and renderer, derived from git tags (APP_VERSION in CI).
const define = { __APP_VERSION__: JSON.stringify(resolveVersion()) }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define,
    build: {
      rollupOptions: {
        // Sandboxed preloads must be a single CommonJS file.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    define,
    build: {
      target: 'es2022',
      rollupOptions: { input: resolve('src/renderer/index.html') }
    },
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] }
  }
})
