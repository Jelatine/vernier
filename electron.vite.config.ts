import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Sandboxed preloads must be a single CommonJS file.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      target: 'es2022',
      rollupOptions: { input: resolve('src/renderer/index.html') }
    },
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] }
  }
})
