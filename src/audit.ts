/**
 * Dependency supply-chain hygiene audit for DeepSeek Harness projects/profiles.
 *
 * Checks are deliberately complementary to dsh-poison-guard (malware/obfuscation
 * scan) and dsh-plugin-doctor (publish readiness): this module looks at the
 * dependency graph itself — peer-range resolvability, broken dist-tags,
 * staleness, non-registry sources, missing licenses, and installed-vs-declared
 * drift (the ERESOLVE / shadowing failure class).
 * @module dsh-dep-audit/audit
 */

import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { satisfies, maxSatisfying, isRegistryRange, compareVersions } from './version.js'
import {
  DEFAULT_REGISTRY,
  fetchRegistryInfo,
  latestTag,
  latestPublishTime,
  normalizeRegistry,
  publishedVersions,
  type RegistryFetch,
  type RegistryPackageInfo,
} from './registry.js'

export type CheckStatus = 'pass' | 'warn' | 'fail'

export type AuditItem = {
  name: string
  issue: string
  level: 'warn' | 'fail'
}

export type CheckResult = {
  id: string
  status: CheckStatus
  title: string
  detail: string
  items: AuditItem[]
}

export interface AuditOptions {
  /** npm registry base URL. Defaults to NPM_CONFIG_REGISTRY or registry.npmjs.org. */
  registry?: string
  /** Include devDependencies in source/license/freshness/drift checks. */
  includeDev?: boolean
  /** Skip all registry network calls. */
  offline?: boolean
  /** Warn when the latest release of a runtime dependency is older than this many days. */
  staleDays?: number
  /** Injectable fetch for tests. */
  fetchImpl?: RegistryFetch
  /** Injectable clock for tests. */
  now?: Date
}

export type AuditReport = {
  schema: 'dsh-dep-audit/v1'
  target: string
  offline: boolean
  ok: boolean
  summary: { total: number; pass: number; warn: number; fail: number }
  checks: CheckResult[]
  generatedAt: string
}

interface Manifest {
  name?: unknown
  version?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

const DEFAULT_STALE_DAYS = 365

function depTable(manifest: Manifest): Record<string, string> {
  const result: Record<string, string> = {}
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const table = manifest[section]
    if (typeof table === 'object' && table !== null) {
      for (const [name, range] of Object.entries(table as Record<string, unknown>)) {
        if (typeof range === 'string') result[name] = range
      }
    }
  }
  return result
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/** Installed version of a top-level dependency inside `dir/node_modules`. */
async function installedVersion(dir: string, name: string): Promise<string | null> {
  const pkgPath = path.join(dir, 'node_modules', name, 'package.json')
  const pkg = await readJson<{ version?: string }>(pkgPath)
  return typeof pkg?.version === 'string' ? pkg.version : null
}

async function hasNodeModules(dir: string): Promise<boolean> {
  return fileExists(path.join(dir, 'node_modules'))
}

function makeCheck(id: string, title: string): CheckResult {
  return { id, title, detail: '', status: 'pass', items: [] }
}

function finishCheck(check: CheckResult): void {
  if (check.items.some((item) => item.level === 'fail')) check.status = 'fail'
  else if (check.items.length > 0) check.status = 'warn'
  else check.status = 'pass'
}

/**
 * Run the full audit against `dir` (a plugin project root or a dsh profile
 * directory that contains package.json at its top level).
 */
export async function audit(dir: string, options: AuditOptions = {}): Promise<AuditReport> {
  const registry = normalizeRegistry(options.registry)
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS
  const offline = options.offline === true
  const includeDev = options.includeDev === true
  const now = options.now ?? new Date()
  const fetchImpl = options.fetchImpl

  const checks: CheckResult[] = []
  const manifestCheck = makeCheck('manifest', 'package.json parses and declares name/version')
  checks.push(manifestCheck)

  const manifest = await readJson<Manifest>(path.join(dir, 'package.json'))
  if (manifest === null) {
    manifestCheck.items.push({ name: path.join(dir, 'package.json'), issue: 'missing or unparseable JSON', level: 'fail' })
    manifestCheck.detail = 'Cannot audit a directory without a valid package.json.'
    finishCheck(manifestCheck)
    return finalize(dir, offline, checks, now)
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    manifestCheck.items.push({ name: 'name', issue: 'missing or empty name field', level: 'fail' })
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    manifestCheck.items.push({ name: 'version', issue: 'missing or empty version field', level: 'fail' })
  }
  finishCheck(manifestCheck)

  const peers = manifest.peerDependencies ?? {}
  const runtime = manifest.dependencies ?? {}
  const dev = manifest.devDependencies ?? {}
  const auditTables = includeDev
    ? { ...runtime, ...dev }
    : runtime

  // 1. Peer-range resolvability (registry-backed).
  const peerCheck = makeCheck(
    'peer-resolvable',
    'Every peerDependency range resolves to a published version on the registry',
  )
  const distTagCheck = makeCheck(
    'dist-tag',
    'dist-tags.latest does not contradict declared ranges (broken dist-tag class, e.g. #2763)',
  )
  checks.push(peerCheck, distTagCheck)

  const peerNames = Object.keys(peers)
  if (peerNames.length === 0) {
    peerCheck.detail = 'No peerDependencies declared.'
  } else if (offline) {
    peerCheck.detail = 'Offline mode: registry checks skipped.'
  } else {
    for (const name of peerNames) {
      const range = peers[name]
      if (range === undefined || !isRegistryRange(range)) continue
      let info: RegistryPackageInfo | null = null
      try {
        info = await fetchRegistryInfo(name, registry, fetchImpl)
      } catch (error) {
        peerCheck.items.push({ name, issue: `registry unreachable: ${String(error instanceof Error ? error.message : error)}`, level: 'warn' })
        continue
      }
      if (info === null) {
        peerCheck.items.push({ name, issue: `package does not exist on ${registry}`, level: 'fail' })
        continue
      }
      const versions = publishedVersions(info)
      if (versions.length === 0) {
        peerCheck.items.push({ name, issue: 'package has no published versions', level: 'fail' })
        continue
      }
      const resolved = maxSatisfying(versions, range)
      if (resolved === null) {
        peerCheck.items.push({ name, issue: `range "${range}" matches no published version (have ${versions.length} versions)`, level: 'fail' })
        continue
      }
      const latest = latestTag(info)
      if (latest !== null && !satisfies(latest, range)) {
        distTagCheck.items.push({
          name,
          issue: `dist-tag latest=${latest} does not satisfy declared range "${range}" (resolved ${resolved}); installs via \`dsh plugin add\` may resolve unexpectedly`,
          level: 'warn',
        })
      }
    }
    peerCheck.detail = `Checked ${peerNames.length} peerDependencies against ${registry}.`
  }
  finishCheck(peerCheck)
  finishCheck(distTagCheck)

  // 2. Non-registry sources in audited (runtime/dev) dependencies.
  const sourceCheck = makeCheck('source', 'Dependencies come from the registry, not git/file/link/workspace URLs')
  checks.push(sourceCheck)
  for (const [name, range] of Object.entries(auditTables)) {
    if (!isRegistryRange(range)) {
      sourceCheck.items.push({ name, issue: `non-registry source specifier: ${range}`, level: 'warn' })
    }
  }
  if (sourceCheck.items.length === 0) sourceCheck.detail = 'All audited dependencies use registry specifiers.'
  finishCheck(sourceCheck)

  // 3-5. Metadata-driven checks for registry-sourced runtime dependencies.
  const licenseCheck = makeCheck('license', 'Runtime dependencies declare a license in their latest published metadata')
  const freshnessCheck = makeCheck('freshness', `Runtime dependencies have a release within the last ${staleDays} days`)
  const outdatedCheck = makeCheck('outdated', 'Installed versions are not behind the registry latest release')
  checks.push(licenseCheck, freshnessCheck, outdatedCheck)

  const registryNames = Object.keys(auditTables).filter((name) => isRegistryRange(auditTables[name] ?? ''))
  if (registryNames.length === 0) {
    licenseCheck.detail = 'No registry-sourced runtime dependencies to check.'
    freshnessCheck.detail = 'No registry-sourced runtime dependencies to check.'
  } else if (offline) {
    licenseCheck.detail = 'Offline mode: license/freshness checks skipped.'
    freshnessCheck.detail = 'Offline mode: license/freshness checks skipped.'
  } else {
    const metas = new Map<string, RegistryPackageInfo | null>()
    let networkError = false
    for (const name of registryNames) {
      try {
        metas.set(name, await fetchRegistryInfo(name, registry, fetchImpl))
      } catch (error) {
        networkError = true
        metas.set(name, null)
        licenseCheck.items.push({ name, issue: `registry unreachable, license unknown`, level: 'warn' })
        freshnessCheck.items.push({ name, issue: `registry unreachable, freshness unknown`, level: 'warn' })
      }
    }
    if (networkError) {
      licenseCheck.detail = `Checked ${registryNames.length} packages with ${registry}; some lookups failed.`
      freshnessCheck.detail = `Checked ${registryNames.length} packages with ${registry}; some lookups failed.`
    }
    for (const name of registryNames) {
      const info = metas.get(name) ?? null
      if (info === null) continue
      const latest = latestTag(info)
      const meta = latest !== null ? info.versions?.[latest] : undefined
      const license = meta?.license
      if (!license) {
        licenseCheck.items.push({ name, issue: `no license field on latest${latest !== null ? ` (${latest})` : ''}`, level: 'warn' })
      }
      const publishedAt = latestPublishTime(info)
      if (latest !== null && publishedAt !== null) {
        const ageDays = (now.getTime() - new Date(publishedAt).getTime()) / 86_400_000
        if (ageDays > staleDays) {
          freshnessCheck.items.push({ name, issue: `latest ${latest} published ${Math.floor(ageDays)} days ago`, level: 'warn' })
        }
      }
      const installed = await installedVersion(dir, name)
      if (installed !== null && latest !== null && compareVersions(latest, installed) > 0) {
        outdatedCheck.items.push({ name, issue: `installed ${installed}, registry latest ${latest}`, level: 'warn' })
      }
    }
    if (licenseCheck.items.length === 0) licenseCheck.detail = `All ${registryNames.length} packages declare a license.`
    if (freshnessCheck.items.length === 0) freshnessCheck.detail = `All ${registryNames.length} packages have a release within ${staleDays} days.`
  }
  finishCheck(licenseCheck)
  finishCheck(freshnessCheck)
  finishCheck(outdatedCheck)

  // 6. Installed-vs-declared drift (ERESOLVE / host-shadowing failure class).
  const driftCheck = makeCheck('drift', 'Installed versions satisfy the declared ranges')
  checks.push(driftCheck)
  const hasModules = await hasNodeModules(dir)
  if (!hasModules) {
    driftCheck.detail = 'node_modules not present; drift check skipped (run pnpm install first).'
  } else {
    const driftNames = Object.keys(auditTables)
    for (const name of driftNames) {
      const range = auditTables[name] ?? ''
      if (!isRegistryRange(range)) continue
      const installed = await installedVersion(dir, name)
      if (installed === null) {
        driftCheck.items.push({ name, issue: 'declared but not installed at the top level', level: 'warn' })
      } else if (!satisfies(installed, range)) {
        driftCheck.items.push({ name, issue: `installed ${installed} does not satisfy "${range}"`, level: 'fail' })
      }
    }
    driftCheck.detail = `Checked ${driftNames.length} declared dependencies against node_modules.`
  }
  finishCheck(driftCheck)

  return finalize(dir, offline, checks, now)
}

function finalize(dir: string, offline: boolean, checks: CheckResult[], now: Date): AuditReport {
  const total = checks.length
  const pass = checks.filter((check) => check.status === 'pass').length
  const warn = checks.filter((check) => check.status === 'warn').length
  const fail = checks.filter((check) => check.status === 'fail').length
  return {
    schema: 'dsh-dep-audit/v1',
    target: dir,
    offline,
    ok: fail === 0,
    summary: { total, pass, warn, fail },
    checks,
    generatedAt: now.toISOString(),
  }
}

export { DEFAULT_REGISTRY }