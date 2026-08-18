/**
 * CLI entry for dsh-dep-audit.
 *
 * Usage:
 *   dsh-dep-audit [dir] [--json] [--offline] [--all] [--registry <url>] [--stale-days <n>]
 *
 * Exit code: 0 when every check passes, 1 when any check fails, 2 on usage error.
 * @module dsh-dep-audit/cli
 */

import { audit } from './audit.js'
import { normalizeRegistry } from './registry.js'

interface CliOptions {
  dir: string
  json: boolean
  offline: boolean
  includeDev: boolean
  registry?: string
  staleDays?: number
}

function usage(): string {
  return [
    'dsh-dep-audit — dependency supply-chain hygiene audit for DeepSeek Harness',
    '',
    'Usage:',
    '  dsh-dep-audit [dir] [options]',
    '',
    'Options:',
    '  --json               print the machine-readable report',
    '  --offline            skip registry network calls',
    '  --all                include devDependencies',
    '  --registry <url>     npm registry base URL',
    '  --stale-days <n>     warn when latest release is older than n days (default 365)',
    '  --help               show this help',
    '',
    'Examples:',
    '  dsh-dep-audit .',
    '  dsh-dep-audit ./my-plugin --json',
    '  dsh-dep-audit ~/.dsh/profiles/web --offline',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions | { help: true } | { error: string } {
  const options: CliOptions = { dir: '.', json: false, offline: false, includeDev: false }
  let positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        return { help: true }
      case '--json':
        options.json = true
        break
      case '--offline':
        options.offline = true
        break
      case '--all':
        options.includeDev = true
        break
      case '--registry':
        options.registry = argv[++i]
        if (options.registry === undefined) return { error: '--registry requires a URL' }
        break
      case '--stale-days':
        options.staleDays = Number(argv[++i])
        if (!Number.isFinite(options.staleDays) || options.staleDays < 1) {
          return { error: '--stale-days requires a positive integer' }
        }
        break
      default:
        if (arg.startsWith('--registry=')) {
          options.registry = arg.slice('--registry='.length)
        } else if (arg.startsWith('--stale-days=')) {
          options.staleDays = Number(arg.slice('--stale-days='.length))
          if (!Number.isFinite(options.staleDays) || options.staleDays < 1) {
            return { error: '--stale-days requires a positive integer' }
          }
        } else if (arg.startsWith('-')) {
          return { error: `unknown option: ${arg}` }
        } else {
          positional.push(arg)
        }
    }
  }
  if (positional.length > 1) return { error: `expected at most one directory, got: ${positional.join(' ')}` }
  if (positional.length === 1) options.dir = positional[0]
  return options
}

function humanReport(report: Awaited<ReturnType<typeof audit>>): string {
  const lines: string[] = []
  lines.push(`dsh-dep-audit ${report.ok ? 'PASS' : 'FAIL'} — ${report.summary.pass} pass / ${report.summary.warn} warn / ${report.summary.fail} fail`)
  lines.push(`target: ${report.target}`)
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.title}`)
    for (const item of check.items) {
      lines.push(`    ${item.level === 'fail' ? '!' : '~'} ${item.name}: ${item.issue}`)
    }
  }
  return lines.join('\n')
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if ('help' in parsed) {
    process.stdout.write(usage() + '\n')
    return 0
  }
  if ('error' in parsed) {
    process.stderr.write(parsed.error + '\n\n' + usage() + '\n')
    return 2
  }

  try {
    const report = await audit(parsed.dir, {
      offline: parsed.offline,
      includeDev: parsed.includeDev,
      registry: parsed.registry === undefined ? normalizeRegistry(undefined) : parsed.registry,
      staleDays: parsed.staleDays,
    })
    if (parsed.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    } else {
      process.stdout.write(humanReport(report) + '\n')
    }
    return report.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`dsh-dep-audit: ${String(error instanceof Error ? error.message : error)}\n`)
    return 2
  }
}
