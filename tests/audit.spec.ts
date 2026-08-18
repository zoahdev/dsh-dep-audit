import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { audit, type AuditOptions } from '../src/audit.js'
import type { RegistryPackageInfo } from '../src/registry.js'

interface MockRegistry {
  url: string
  close: () => Promise<void>
  hits: () => string[]
}

function startMockRegistry(routes: Record<string, RegistryPackageInfo>): Promise<MockRegistry> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const name = decodeURIComponent(url.pathname.slice(1))
    hits.push(name)
    const info = routes[name]
    if (info === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(info))
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind registry server'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
        hits: () => [...hits],
      })
    })
  })
}

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-dep-audit-'))
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

const STALE_DAYS_AGO = new Date(Date.now() - 400 * 86_400_000).toISOString()
const FRESH = new Date(Date.now() - 2 * 86_400_000).toISOString()

function depInfo(versions: Record<string, { license?: string }>, latest: string, times: Record<string, string>): RegistryPackageInfo {
  return {
    name: 'x',
    'dist-tags': { latest },
    versions: Object.fromEntries(Object.entries(versions).map(([v, m]) => [v, m as never])) as never,
    time: { created: FRESH, modified: FRESH, ...times },
  }
}

const dshToolsOk = depInfo(
  { '0.1.0-rc.5': { license: 'MIT' }, '0.1.0-rc.6': { license: 'MIT' }, '0.1.0': { license: 'MIT' } },
  '0.1.0-rc.6',
  { '0.1.0-rc.5': FRESH, '0.1.0-rc.6': FRESH, '0.1.0': FRESH },
)

const goodDep = depInfo(
  { '1.0.0': { license: 'MIT' }, '1.2.0': { license: 'MIT' } },
  '1.2.0',
  { '1.0.0': FRESH, '1.2.0': FRESH },
)

let registry: MockRegistry

beforeAll(async () => {
  registry = await startMockRegistry({
    '@deepseek-ai/dsh-tools': dshToolsOk,
    'good-dep': goodDep,
    'stale-dep': depInfo({ '1.0.0': { license: 'MIT' } }, '1.0.0', { '1.0.0': STALE_DAYS_AGO }),
    'no-license-dep': depInfo({ '1.0.0': {} }, '1.0.0', { '1.0.0': FRESH }),
    'only-rc1': depInfo({ '0.0.1-rc.1': { license: 'MIT' } }, '0.0.1-rc.1', { '0.0.1-rc.1': FRESH }),
  })
})

afterAll(async () => {
  await registry.close()
})

async function run(dir: string, options: Omit<AuditOptions, 'fetchImpl'> = {}) {
  return audit(dir, { ...options, registry: registry.url })
}

function manifestOf(deps: Record<string, string>, peers: Record<string, string> = {}): string {
  return JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: deps, peerDependencies: peers }, null, 2)
}

describe('manifest check', () => {
  it('fails when package.json is missing', async () => {
    const dir = makeProject({})
    try {
      const report = await run(dir)
      expect(report.ok).toBe(false)
      expect(report.summary.fail).toBeGreaterThan(0)
      const manifest = report.checks.find((check) => check.id === 'manifest')
      expect(manifest?.status).toBe('fail')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails on an empty version field', async () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ name: 'x' }) })
    try {
      const report = await run(dir)
      const manifest = report.checks.find((check) => check.id === 'manifest')
      expect(manifest?.status).toBe('fail')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('peer resolvability', () => {
  it('passes when every peer resolves', async () => {
    const dir = makeProject({
      'package.json': manifestOf({ 'good-dep': '^1.0.0' }, { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' }),
    })
    try {
      const report = await run(dir)
      const peer = report.checks.find((check) => check.id === 'peer-resolvable')
      expect(peer?.status).toBe('pass')
      expect(report.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when a peer range matches no published version', async () => {
    const dir = makeProject({
      'package.json': manifestOf({}, { 'only-rc1': '^0.1.0-rc.6' }),
    })
    try {
      const report = await run(dir)
      const peer = report.checks.find((check) => check.id === 'peer-resolvable')
      expect(peer?.status).toBe('fail')
      expect(peer?.items.some((item) => item.name === 'only-rc1')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('warns when the latest dist-tag contradicts a resolvable range (#2763 class)', async () => {
    const dir = makeProject({
      'package.json': manifestOf({}, { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' }),
    })
    try {
      const broken = await startMockRegistry({
        '@deepseek-ai/dsh-tools': {
          name: '@deepseek-ai/dsh-tools',
          'dist-tags': { latest: '0.0.1-rc.1' },
          versions: {
            '0.0.1-rc.1': { license: 'MIT' },
            '0.1.0-rc.6': { license: 'MIT' },
          } as never,
          time: { '0.0.1-rc.1': FRESH, '0.1.0-rc.6': FRESH },
        },
      })
      try {
        const report = await audit(dir, { registry: broken.url })
        const distTag = report.checks.find((check) => check.id === 'dist-tag')
        expect(distTag?.status).toBe('warn')
        const peer = report.checks.find((check) => check.id === 'peer-resolvable')
        expect(peer?.status).toBe('pass')
      } finally {
        await broken.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('metadata checks', () => {
  it('warns on stale and missing-license dependencies', async () => {
    const dir = makeProject({
      'package.json': manifestOf({ 'stale-dep': '^1.0.0', 'no-license-dep': '^1.0.0' }),
    })
    try {
      const report = await run(dir)
      const freshness = report.checks.find((check) => check.id === 'freshness')
      const license = report.checks.find((check) => check.id === 'license')
      expect(freshness?.status).toBe('warn')
      expect(freshness?.items.some((item) => item.name === 'stale-dep')).toBe(true)
      expect(license?.status).toBe('warn')
      expect(license?.items.some((item) => item.name === 'no-license-dep')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('warns on non-registry sources', async () => {
    const dir = makeProject({
      'package.json': manifestOf({ 'good-dep': '^1.0.0', 'local-thing': 'file:./local-thing' }),
    })
    try {
      const report = await run(dir)
      const source = report.checks.find((check) => check.id === 'source')
      expect(source?.status).toBe('warn')
      expect(source?.items.some((item) => item.name === 'local-thing')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('drift check', () => {
  it('fails when the installed version does not satisfy the declared range', async () => {
    const dir = makeProject({
      'package.json': manifestOf({ 'good-dep': '^2.0.0' }),
      'node_modules/good-dep/package.json': JSON.stringify({ name: 'good-dep', version: '1.0.0' }),
    })
    try {
      const report = await run(dir)
      const drift = report.checks.find((check) => check.id === 'drift')
      expect(drift?.status).toBe('fail')
      expect(drift?.items.some((item) => item.name === 'good-dep' && item.level === 'fail')).toBe(true)
      expect(report.ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes when installed versions satisfy declared ranges', async () => {
    const dir = makeProject({
      'package.json': manifestOf({ 'good-dep': '^1.0.0' }),
      'node_modules/good-dep/package.json': JSON.stringify({ name: 'good-dep', version: '1.2.0' }),
    })
    try {
      const report = await run(dir)
      const drift = report.checks.find((check) => check.id === 'drift')
      expect(drift?.status).toBe('pass')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('offline mode', () => {
  it('skips registry calls entirely', async () => {
    const dir = makeProject({
      'package.json': manifestOf({}, { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' }),
    })
    try {
      const before = registry.hits().length
      const report = await run(dir, { offline: true })
      expect(registry.hits().length).toBe(before)
      expect(report.offline).toBe(true)
      const peer = report.checks.find((check) => check.id === 'peer-resolvable')
      expect(peer?.detail).toContain('Offline')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('envelope', () => {
  it('produces the dsh-dep-audit/v1 envelope', async () => {
    const dir = makeProject({
      'package.json': manifestOf({ 'good-dep': '^1.0.0' }, { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' }),
    })
    try {
      const report = await run(dir)
      expect(report.schema).toBe('dsh-dep-audit/v1')
      expect(typeof report.ok).toBe('boolean')
      expect(report.summary.total).toBe(report.checks.length)
      expect(report.summary.pass + report.summary.warn + report.summary.fail).toBe(report.summary.total)
      for (const check of report.checks) {
        expect(['pass', 'warn', 'fail']).toContain(check.status)
        expect(check.id).toBeTruthy()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})