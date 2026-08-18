/**
 * Registry metadata access for dsh-dep-audit.
 *
 * Uses the global `fetch` (Node 18+). The fetch implementation is injectable
 * so tests can run a local HTTP server and offline cases can be simulated.
 * @module dsh-dep-audit/registry
 */

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** The shape of the npm registry "full metadata" document we consume. */
export interface RegistryPackageInfo {
  name: string
  'dist-tags'?: Record<string, string>
  versions?: Record<string, { license?: string; deprecated?: boolean }>
  time?: Record<string, string>
}

export interface RegistryFetch {
  (url: string, init?: { signal?: AbortSignal }): Promise<Response>
}

/** Normalize a registry base URL (strip trailing slash). */
export function normalizeRegistry(input: string | undefined): string {
  const value = (input?.trim() || process.env.NPM_CONFIG_REGISTRY?.trim() || DEFAULT_REGISTRY).replace(/\/+$/, '')
  return value === '' ? DEFAULT_REGISTRY : value
}

/** npm registry encoding for scoped names: @scope/pkg -> @scope%2Fpkg. */
export function encodePackageName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2F') : name
}

/**
 * Fetch the full metadata document for `name` from `registry`.
 * Returns null when the package does not exist (404) or the metadata is empty.
 * Throws on network errors so callers can decide how to degrade.
 */
export async function fetchRegistryInfo(
  name: string,
  registry: string,
  fetchImpl: RegistryFetch = fetch,
  timeoutMs = 10_000,
): Promise<RegistryPackageInfo | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${registry}/${encodePackageName(name)}`, { signal: controller.signal })
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`registry responded ${response.status} for ${name}`)
    }
    const data = await response.json() as RegistryPackageInfo
    if (typeof data !== 'object' || data === null || typeof data.name !== 'string') return null
    return data
  } finally {
    clearTimeout(timer)
  }
}

/** All published version strings for a package, sorted ascending. */
export function publishedVersions(info: RegistryPackageInfo | null): string[] {
  if (info === null || info.versions === undefined) return []
  return Object.keys(info.versions).sort()
}

/** The `latest` dist-tag version string, if any. */
export function latestTag(info: RegistryPackageInfo | null): string | null {
  return info?.['dist-tags']?.latest ?? null
}

/** Publish time (ISO string) of a specific version, if known. */
export function publishTimeOf(info: RegistryPackageInfo | null, version: string): string | null {
  return info?.time?.[version] ?? null
}

/** Publish time of the `latest` dist-tag version, if known. */
export function latestPublishTime(info: RegistryPackageInfo | null): string | null {
  const latest = latestTag(info)
  if (latest === null) return null
  return publishTimeOf(info, latest)
}