/**
 * dsh-dep-audit — dependency supply-chain hygiene audit for DeepSeek Harness.
 *
 * Model-facing tool `dep_audit` plus a reusable audit core. Complements
 * dsh-poison-guard (malware/obfuscation scan) and dsh-plugin-doctor
 * (publish readiness): this one checks the dependency graph itself.
 * @module dsh-dep-audit
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRequire } from 'node:module'
import { satisfiesCaret } from './version.js'
import { audit, type AuditReport, type AuditOptions } from './audit.js'
import { DEFAULT_REGISTRY } from './registry.js'

export const name = 'dsh-dep-audit'

/** Services required by this plugin. */
export const inject = ['tools']

/** Peer range this plugin is tested against and guards at runtime. */
export const TESTED_PEER_RANGE = '^0.1.0-rc.6'

const require = createRequire(import.meta.url)

/** Resolve the dsh-tools version the plugin is actually linked against. */
export function resolvedDshToolsVersion(): string {
  try {
    const pkg = require('@deepseek-ai/dsh-tools/package.json') as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unresolved'
  }
}

/**
 * Turn a silent peer mismatch into a loud, actionable load error.
 * pnpm can link an older RC into the plugin's peer slot without failing.
 */
export function assertPeerCompatible(): void {
  const version = resolvedDshToolsVersion()
  if (!satisfiesCaret(version, TESTED_PEER_RANGE)) {
    throw new Error(
      `dsh-dep-audit: resolved @deepseek-ai/dsh-tools ${version}, but this plugin is tested with `
      + `${TESTED_PEER_RANGE}. Upgrade DeepSeek Harness to 0.1.0-rc.6 or later, then reinstall this plugin.`,
    )
  }
}

/** Plugin configuration supplied through cordis.yml. */
export interface Config {
  /** npm registry base URL. */
  registry?: string
  /** Skip all registry network calls. */
  offline?: boolean
  /** Include devDependencies in the audit. */
  includeDev?: boolean
  /** Warn when the latest release is older than this many days. */
  staleDays?: number
}

/** Schemastery schema with defaults. */
export const Config: Schema<Config> = Schema.object({
  registry: Schema.string().default(DEFAULT_REGISTRY),
  offline: Schema.boolean().default(false),
  includeDev: Schema.boolean().default(false),
  staleDays: Schema.number().min(1).default(365),
})

/** Render a report as plain text blocks for the model. */
export function renderReport(report: AuditReport): string[] {
  const lines: string[] = []
  lines.push(`dsh-dep-audit ${report.ok ? 'PASS' : 'FAIL'} — ${report.summary.pass} pass / ${report.summary.warn} warn / ${report.summary.fail} fail`)
  for (const check of report.checks) {
    lines.push(`- [${check.status.toUpperCase()}] ${check.title}`)
    for (const item of check.items) {
      lines.push(`    ${item.level === 'fail' ? '!' : '~'} ${item.name}: ${item.issue}`)
    }
  }
  return lines
}

/**
 * Register the dep_audit tool on the tool registry.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertPeerCompatible()
  ctx.tools.register(defineTool({
    name: 'dep_audit',
    description:
      'Audit the dependency supply-chain hygiene of a dsh plugin project or profile directory: '
      + 'peer-range resolvability against the registry, broken dist-tag detection, stale or '
      + 'non-registry dependencies, missing licenses, and installed-vs-declared drift. '
      + 'Returns a dsh-dep-audit/v1 report with PASS/WARN/FAIL checks.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Directory containing package.json to audit' },
      options: {
        type: 'object',
        additionalProperties: true,
        description: 'Audit options (registry/offline/includeDev/staleDays)',
        properties: {
          registry: { type: 'string' },
          offline: { type: 'boolean' },
          includeDev: { type: 'boolean' },
          staleDays: { type: 'number' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
                properties: {
          schema: { type: 'string' },
          target: { type: 'string', required: true },
          offline: { type: 'boolean' },
          ok: { type: 'boolean' },
          generatedAt: { type: 'string' },
          summary: { type: 'object', additionalProperties: true },
          checks: { type: 'array' },
        },
      },
      render: (_args, value) => renderReport(value as AuditReport).map((text) => ({ type: 'text' as const, text })),
    },
    async execute(args, _exec): Promise<AuditReport> {
      const merged: AuditOptions = {
        registry: args.options?.registry ?? config.registry,
        offline: args.options?.offline ?? config.offline,
        includeDev: args.options?.includeDev ?? config.includeDev,
        staleDays: args.options?.staleDays ?? config.staleDays,
      }
      return audit(args.dir, merged)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Audit dependencies: ${args.dir}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}