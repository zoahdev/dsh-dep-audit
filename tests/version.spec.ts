import { describe, expect, it } from 'vitest'
import {
  parseVersion,
  compareVersions,
  satisfies,
  maxSatisfying,
  isRegistryRange,
  satisfiesCaret,
} from '../src/version.js'

describe('parseVersion', () => {
  it('parses stable and prerelease versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null })
    expect(parseVersion('0.1.0-rc.6')?.prerelease).toEqual(['rc', '6'])
    expect(parseVersion('v2.0.0')?.major).toBe(2)
    expect(parseVersion('nope')).toBeNull()
    expect(parseVersion('1.2')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders stable and prerelease versions', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0-rc.6', '0.1.0-rc.10')).toBeLessThan(0)
  })
})

describe('satisfies', () => {
  it('handles exact ranges', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true)
    expect(satisfies('1.2.4', '1.2.3')).toBe(false)
  })

  it('handles caret ranges including 0.x', () => {
    expect(satisfies('1.5.0', '^1.2.3')).toBe(true)
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfies('0.1.9', '^0.1.0')).toBe(true)
    expect(satisfies('0.2.0', '^0.1.0')).toBe(false)
  })

  it('handles prerelease caret ranges', () => {
    expect(satisfies('0.1.0-rc.6', '^0.1.0-rc.6')).toBe(true)
    expect(satisfies('0.1.0-rc.7', '^0.1.0-rc.6')).toBe(true)
    expect(satisfies('0.1.0', '^0.1.0-rc.6')).toBe(true)
    expect(satisfies('0.1.0-rc.3', '^0.1.0-rc.6')).toBe(false)
    // A range without prerelease does not match prereleases of the same tuple.
    expect(satisfies('0.1.0-rc.6', '^0.1.0')).toBe(false)
  })

  it('handles tilde ranges', () => {
    expect(satisfies('1.4.9', '~1.4.0')).toBe(true)
    expect(satisfies('1.5.0', '~1.4.0')).toBe(false)
  })

  it('handles stars and partials', () => {
    expect(satisfies('9.9.9', '*')).toBe(true)
    expect(satisfies('1.2.3', '1')).toBe(true)
    expect(satisfies('2.0.0', '1')).toBe(false)
    expect(satisfies('1.9.0', '1.x')).toBe(true)
  })

  it('handles bare-major comparator bounds like <5 and >=1.2', () => {
    expect(satisfies('4.0.1', '>=4.0.0 <5')).toBe(true)
    expect(satisfies('5.0.0', '>=4.0.0 <5')).toBe(false)
    expect(satisfies('1.2.3', '>=1.2')).toBe(true)
    expect(satisfies('1.1.9', '>=1.2')).toBe(false)
  })

  it('handles comparator chains and unions', () => {
    expect(satisfies('1.5.0', '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfies('2.1.0', '>=1.0.0 <2.0.0')).toBe(false)
    expect(satisfies('3.0.0', '^1.0.0 || ^3.0.0')).toBe(true)
    expect(satisfies('2.0.0', '^1.0.0 || ^3.0.0')).toBe(false)
  })
})

describe('maxSatisfying', () => {
  it('picks the highest compatible version', () => {
    const versions = ['0.0.1-rc.1', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0']
    expect(maxSatisfying(versions, '^0.1.0-rc.6')).toBe('0.1.0')
    expect(maxSatisfying(versions, '^0.1.0')).toBe('0.1.0')
    expect(maxSatisfying(versions, '^0.2.0')).toBeNull()
  })
})

describe('isRegistryRange', () => {
  it('distinguishes registry ranges from git/file/link/workspace', () => {
    expect(isRegistryRange('^1.0.0')).toBe(true)
    expect(isRegistryRange('*')).toBe(true)
    expect(isRegistryRange('file:./x.tgz')).toBe(false)
    expect(isRegistryRange('git+https://github.com/a/b.git')).toBe(false)
    expect(isRegistryRange('workspace:*')).toBe(false)
    expect(isRegistryRange('https://example.com/x.tgz')).toBe(false)
  })
})

describe('satisfiesCaret', () => {
  it('guards the plugin peer range', () => {
    expect(satisfiesCaret('0.1.0-rc.6', '^0.1.0-rc.6')).toBe(true)
    expect(satisfiesCaret('0.1.0-rc.3', '^0.1.0-rc.6')).toBe(false)
    expect(satisfiesCaret('0.0.1-rc.1', '^0.1.0-rc.6')).toBe(false)
  })
})