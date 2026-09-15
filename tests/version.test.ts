import { describe, expect, it } from 'vitest'
import { resolveVersion, versionFromDescribe } from '../scripts/version.mjs'
import { compareVersions, isNewer, parseVersion } from '../src/shared/version'

describe('versionFromDescribe', () => {
  it('uses the tag when HEAD is exactly on it', () => {
    expect(versionFromDescribe('v0.1.0-0-gfb23eee')).toBe('0.1.0')
    expect(versionFromDescribe('v1.2.0-beta.1-0-gabc1234')).toBe('1.2.0-beta.1')
  })
  it('makes commits after a tag a prerelease of the next patch', () => {
    expect(versionFromDescribe('v0.1.0-3-gfb23eee')).toBe('0.1.1-dev.3+gfb23eee')
    expect(versionFromDescribe('v0.1.0-0-gfb23eee-dirty')).toBe('0.1.1-dev.dirty+gfb23eee')
    expect(isNewer('0.1.1', versionFromDescribe('v0.1.0-3-gfb23eee')!)).toBe(true)
    expect(isNewer('0.1.0', versionFromDescribe('v0.1.0-3-gfb23eee')!)).toBe(false)
  })
  it('rejects non-version tags', () => {
    expect(versionFromDescribe('release-5-gabc')).toBeNull()
  })
  it('prefers APP_VERSION from the environment', () => {
    expect(resolveVersion({ env: { APP_VERSION: 'v3.4.5' } })).toBe('3.4.5')
    expect(resolveVersion({ env: {} })).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('compareVersions', () => {
  it('orders by semver precedence', () => {
    const sorted = ['1.0.0', '1.0.0-alpha', '1.0.0-alpha.1', '0.9.9', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.1', '1.0.0-rc.1', '1.0.0-alpha.beta']
    sorted.sort(compareVersions)
    expect(sorted).toEqual(['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1'])
  })
  it('ignores a leading v and build metadata', () => {
    expect(compareVersions('v1.2.3', '1.2.3+g123')).toBe(0)
    expect(isNewer('v0.2.0', '0.1.9')).toBe(true)
    expect(parseVersion('not-a-version')).toBeNull()
    expect(isNewer('garbage', '0.1.0')).toBe(false)
  })
})
