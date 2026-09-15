// The app version comes from git tags, not package.json.
//   APP_VERSION env (CI sets it from the pushed tag)  ->  "0.2.0"
//   HEAD exactly on tag v0.2.0                        ->  "0.2.0"
//   3 commits after v0.2.0                            ->  "0.2.1-dev.3+g1a2b3c4"
//   no tags                                           ->  "0.0.0-dev+g1a2b3c4"
import { execFileSync } from 'node:child_process'

/** Parse `git describe --tags --long` output into a semver string, or null. */
export function versionFromDescribe(describe) {
  const m = /^v(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+?)?-(\d+)-g([0-9a-f]+)(-dirty)?$/.exec(describe.trim())
  if (!m) return null
  const [, major, minor, patch, pre, ahead, sha, dirty] = m
  if (ahead === '0' && !dirty) return `${major}.${minor}.${patch}${pre ?? ''}`
  const n = ahead === '0' ? 'dirty' : ahead
  return `${major}.${minor}.${Number(patch) + 1}-dev.${n}+g${sha}`
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

export function resolveVersion({ env = process.env, cwd = process.cwd() } = {}) {
  const fromEnv = env.APP_VERSION?.trim()
  if (fromEnv) return fromEnv.replace(/^v/, '')
  try {
    const v = versionFromDescribe(git(['describe', '--tags', '--match', 'v[0-9]*', '--long'], cwd))
    if (v) return v
  } catch {
    // no matching tag
  }
  try {
    return `0.0.0-dev+g${git(['rev-parse', '--short', 'HEAD'], cwd)}`
  } catch {
    return '0.0.0-dev'
  }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(resolveVersion())
