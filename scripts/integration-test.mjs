#!/usr/bin/env node
/**
 * Packaged integration + real runtime invocation smoke test.
 *
 * Installs the ACTUAL pnpm-packed tarball into a fresh project, loads the
 * installed plugin bundle, registers the dep_audit tool through the real
 * `apply()` / `ctx.tools.register` path, executes the real handler against
 * a fixture project, renders the result through the real renderer, and
 * asserts every step. A missing module, an API mismatch, or a handler
 * failure fails this script.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tgz = path.resolve(process.argv[2] ?? path.join(root, 'dsh-dep-audit-0.1.0.tgz'))

if (!existsSync(tgz)) {
  console.error(`[integration] missing tarball: ${tgz}`)
  process.exit(1)
}

function runPnpm(args, cwd) {
  if (process.platform === 'win32') {
    return spawnSync(`pnpm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true })
  }
  return spawnSync('pnpm', args, { cwd, stdio: 'inherit' })
}

/** A fixture project that passes the offline drift/source/manifest checks. */
function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-dep-audit-target-'))
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-target', version: '1.0.0', dependencies: { 'good-dep': '^1.0.0' } }, null, 2),
  )
  mkdirSync(path.join(dir, 'node_modules', 'good-dep'), { recursive: true })
  writeFileSync(
    path.join(dir, 'node_modules', 'good-dep', 'package.json'),
    JSON.stringify({ name: 'good-dep', version: '1.2.0' }),
  )
  return dir
}

async function scenario(name, dshToolsVersion, expectGuard) {
  const dir = mkdtempSync(path.join(tmpdir(), `dsh-dep-audit-${name}-`))
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-dep-audit-integration-host',
        private: true,
        version: '1.0.0',
        dependencies: {
          '@deepseek-ai/cordis': '^4.0.1',
          '@deepseek-ai/dsh-tools': dshToolsVersion,
          '@deepseek-ai/schemastery': '^3.18.1',
          'dsh-dep-audit': `file:${tgz.replaceAll('\\', '/')}`,
        },
      },
      null,
      2,
    ),
  )

  console.log(`[integration:${name}] installing packed tarball into fresh project (dsh-tools ${dshToolsVersion})...`)
  const install = runPnpm(['install'], dir)
  if (install.status !== 0) {
    console.error(`[integration:${name}] pnpm install failed`)
    process.exit(1)
  }

  const pluginIndex = path.join(dir, 'node_modules', 'dsh-dep-audit', 'lib', 'index.js')
  if (!existsSync(pluginIndex)) {
    throw new Error('packed plugin entry lib/index.js missing after install')
  }

  console.log(`[integration:${name}] loading packed plugin bundle...`)
  const plugin = await import(pathToFileURL(pluginIndex).href)

  if (plugin.name !== 'dsh-dep-audit') {
    throw new Error(`unexpected plugin name: ${plugin.name}`)
  }

  const registered = []
  const ctx = {
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      },
    },
  }

  if (expectGuard) {
    let threw = false
    try {
      plugin.apply(ctx, { registry: 'https://registry.npmjs.org', offline: false, includeDev: false, staleDays: 365 })
    } catch (error) {
      threw = true
      if (!String(error instanceof Error ? error.message : error).includes('tested with ^0.1.0-rc.6')) {
        throw new Error(`guard threw an unexpected error: ${String(error)}`)
      }
    }
    if (!threw) {
      throw new Error('runtime guard did not reject the incompatible dsh-tools version')
    }
    console.log(`PASS [${name}] runtime guard rejected incompatible @deepseek-ai/dsh-tools ${dshToolsVersion}`)
    rmSync(dir, { recursive: true, force: true })
    return
  }

  console.log(`[integration:${name}] calling apply(ctx, config) through the real registration path...`)
  plugin.apply(ctx, { registry: 'https://registry.npmjs.org', offline: true, includeDev: false, staleDays: 365 })

  const tool = registered.find((definition) => definition.name === 'dep_audit')
  if (tool === undefined) {
    throw new Error('dep_audit tool was not registered via apply/ctx.tools.register')
  }

  if (tool.parameters?.properties?.dir === undefined) {
    throw new Error('dep_audit schema missing the dir parameter')
  }

  console.log(`[integration:${name}] executing the real dep_audit handler against a fixture...`)
  const fixture = makeFixture()
  try {
    const report = await tool.execute({ dir: fixture, options: { offline: true } }, { signal: new AbortController().signal })
    if (report?.schema !== 'dsh-dep-audit/v1') {
      throw new Error(`unexpected canonical result: ${JSON.stringify(report)}`)
    }
    if (report.ok !== true) {
      throw new Error(`fixture audit should pass offline, got: ${JSON.stringify(report.checks)}`)
    }

    console.log(`[integration:${name}] rendering through the real output.render...`)
    const blocks = tool.output.render({ dir: fixture }, report)
    const text = blocks.map((block) => block.text ?? '').join('\n')
    if (!text.includes('dsh-dep-audit PASS')) {
      throw new Error(`render output missing PASS marker: ${JSON.stringify(text)}`)
    }

    console.log(`PASS [${name}] packed artifact loaded, dep_audit registered, handler executed, render asserted`)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}

await scenario('happy', '0.1.0-rc.6', false)
await scenario('guard', '0.1.0-rc.3', true)