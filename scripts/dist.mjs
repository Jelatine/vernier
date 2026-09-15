// electron-builder with the app version taken from git tags (scripts/version.mjs).
// Usage: node scripts/dist.mjs [electron-builder args...]
import { spawnSync } from 'node:child_process'
import { resolveVersion } from './version.mjs'

const version = resolveVersion()
console.log(`Packaging Vernier ${version}`)
const result = spawnSync('npx', ['electron-builder', ...process.argv.slice(2), `-c.extraMetadata.version=${version}`], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
process.exit(result.status ?? 1)
