# dsh-dep-audit

[![CI](https://github.com/zoahdev/dsh-dep-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/zoahdev/dsh-dep-audit/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-verified-blue)](https://github.com/topics/dsh-plugin)

Dependency supply-chain hygiene audit for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) projects and profiles.

It answers: **“can I trust the dependency graph of this dsh plugin / profile?”** — peer ranges that resolve to nothing, dist-tags that contradict declared ranges, stale or unlicensed dependencies, non-registry sources, and installed versions that silently drifted from what `package.json` declares.

Complements the rest of the zoahdev security suite:

| Tool | Focus |
|---|---|
| [dsh-poison-guard](https://github.com/zoahdev/dsh-poison-guard) | malware / obfuscation scan of plugin code |
| [dsh-plugin-doctor](https://github.com/zoahdev/dsh-plugin-doctor) | publish readiness: manifest/patch/build/pack/install |
| **dsh-dep-audit** | dependency graph hygiene: resolvability, dist-tags, staleness, sources, licenses, drift |

## Install

```sh
dsh plugin add dsh-dep-audit
```

Or run it standalone without installing into dsh:

```sh
npx dsh-dep-audit .
```

## Checks

| Check | What it verifies | Status when triggered |
|---|---|---|
| `manifest` | `package.json` exists, parses, declares `name` / `version` | fail |
| `peer-resolvable` | every `peerDependencies` range matches at least one published version on the registry | fail |
| `dist-tag` | `dist-tags.latest` does not contradict a declared range (the broken-`latest` / ERESOLVE class, e.g. [discussion #2763](https://github.com/deepseek-ai/deepseek-harness/discussions/2763)) | warn |
| `source` | audited dependencies use registry specifiers, not `git:` / `file:` / `link:` / `workspace:` | warn |
| `license` | registry dependencies declare a license in their latest published metadata | warn |
| `freshness` | registry dependencies have a release within the last 365 days (configurable) | warn |
| `drift` | installed versions in `node_modules` satisfy the declared ranges (ERESOLVE / host-shadowing class) | fail |
| `outdated` | installed versions are not behind the registry `latest` | warn |

`ok` is `true` only when every check passes (no fail items). Warnings are real signals but not blockers.

## CLI

```sh
dsh-dep-audit [dir] [options]

  --json               print the machine-readable report
  --offline            skip registry network calls
  --all                include devDependencies
  --registry <url>     npm registry base URL (default: NPM_CONFIG_REGISTRY or registry.npmjs.org)
  --stale-days <n>     warn when latest release is older than n days (default 365)
  --help               show help
```

Exit codes: `0` all pass, `1` at least one fail, `2` usage/IO error.

```sh
npx dsh-dep-audit . --json
npx dsh-dep-audit ~/.dsh/profiles/web --offline
```

## In-harness usage (agent-callable)

After install, ask your dsh agent:

> 审计一下当前插件的依赖健康：`dep_audit`，目录指向项目根目录。
> Run a dependency audit on this plugin: `dep_audit` with `dir` set to the project root.

The agent calls the `dep_audit` tool (`dir`, optional `options`), which returns a `dsh-dep-audit/v1` report:

```json
{
  "schema": "dsh-dep-audit/v1",
  "target": ".",
  "offline": false,
  "ok": true,
  "summary": { "total": 8, "pass": 8, "warn": 0, "fail": 0 },
  "checks": [ ... ]
}
```

## Examples

Audit a profile without network access:

```sh
npx dsh-dep-audit ~/.dsh/profiles/web --offline
```

Gate CI on dependency hygiene:

```yaml
- run: npx dsh-dep-audit .
```

## Why it exists

- pnpm can silently link an older RC into a plugin's peer slot; **“loads fine” ≠ “matches the declared peer range”**. `drift` turns that precondition into a checked fact.
- The npm `latest` dist-tag can point at an old, broken build while `next` has the real release — `dsh plugin add <name>` then resolves something unexpected for everyone. `dist-tag` flags the contradiction before it bites (the [discussion #2763](https://github.com/deepseek-ai/deepseek-harness/discussions/2763) failure class).
- A dependency whose latest release is years old, or that lacks a license, is a red flag in a supply chain that grows by thousands of plugins per week.
- An unlicensed or stale dependency is not malware — that is poison-guard's job. This plugin is the “healthy diet” half of the supply-chain story.

## Report envelope

Every check carries `{ id, status, title, detail, items }`; `items` are `{ name, issue, level }` with `level: warn | fail`. The schema version (`dsh-dep-audit/v1`) is stable and machine-readable for CI.

## Development

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration
```

CI runs the [dsh-plugin-doctor](https://github.com/zoahdev/dsh-plugin-doctor) preflight, unit tests, a packed-artifact integration that installs the real tarball and invokes the real `dep_audit` handler, and a fresh-profile `dsh web` boot smoke on Windows.

## License

MIT © 2026 zoahdev

---

# dsh-dep-audit（中文）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）项目与 profile 的**依赖供应链卫生审计**。

回答一个具体问题：**“这个 dsh 插件 / profile 的依赖图能信吗？”** —— peer 范围在注册表上解析不到、dist-tag 与声明的范围互相矛盾、依赖长期不更新或没有许可证、用了 git/file/workspace 来源，以及安装版本与 `package.json` 声明悄悄漂移。

与 zoahdev 安全套件的分工：

| 工具 | 定位 |
|---|---|
| [dsh-poison-guard](https://github.com/zoahdev/dsh-poison-guard) | 插件代码的恶意/混淆扫描 |
| [dsh-plugin-doctor](https://github.com/zoahdev/dsh-plugin-doctor) | 发布就绪：manifest/patch/build/pack/install |
| **dsh-dep-audit** | 依赖图卫生：可解析性、dist-tag、过期、来源、许可证、漂移 |

## 安装

```sh
dsh plugin add dsh-dep-audit
```

不装进 dsh 也能单独用：

```sh
npx dsh-dep-audit .
```

## 检查项

| 检查 | 验证内容 | 触发级别 |
|---|---|---|
| `manifest` | `package.json` 存在、可解析、有 `name` / `version` | fail |
| `peer-resolvable` | 每个 `peerDependencies` 范围在注册表上至少有一个已发布版本 | fail |
| `dist-tag` | `dist-tags.latest` 不与声明范围矛盾（坏 `latest` / ERESOLVE 一类，见 [讨论 #2763](https://github.com/deepseek-ai/deepseek-harness/discussions/2763)） | warn |
| `source` | 依赖使用注册表来源，而非 `git:` / `file:` / `link:` / `workspace:` | warn |
| `license` | 注册表依赖的最新元数据声明了许可证 | warn |
| `freshness` | 注册表依赖在 365 天内有新发布（可配置） | warn |
| `drift` | `node_modules` 里的实际版本满足声明范围（ERESOLVE / 宿主遮蔽类） | fail |
| `outdated` | 已安装版本不落后于注册表 `latest` | warn |

只有所有检查都没有 fail 项时 `ok` 才为 `true`。warn 是真实信号，但不是硬阻塞。

## CLI

```sh
dsh-dep-audit [dir] [options]

  --json               输出机器可读报告
  --offline            跳过注册表网络请求
  --all                把 devDependencies 也纳入审计
  --registry <url>     npm 注册表地址（默认 NPM_CONFIG_REGISTRY 或 registry.npmjs.org）
  --stale-days <n>     超过 n 天未发布即告警（默认 365）
  --help               帮助
```

退出码：`0` 全过，`1` 有 fail，`2` 用法/IO 错误。

```sh
npx dsh-dep-audit . --json
npx dsh-dep-audit ~/.dsh/profiles/web --offline
```

## 在 harness 内使用（agent 可调用）

装好后对 agent 说：

> 审计一下当前插件的依赖健康：`dep_audit`，目录指向项目根目录。

agent 会调用 `dep_audit` 工具（`dir`，可选 `options`），返回 `dsh-dep-audit/v1` 报告：

```json
{
  "schema": "dsh-dep-audit/v1",
  "target": ".",
  "offline": false,
  "ok": true,
  "summary": { "total": 8, "pass": 8, "warn": 0, "fail": 0 },
  "checks": [ ... ]
}
```

## 为什么需要它

- pnpm 可能把旧 RC 静默链进插件的 peer 槽；**“能加载”≠“符合声明的 peer 范围”**。`drift` 把这条前置条件变成可核验的事实。
- npm 的 `latest` dist-tag 可能指向旧坏包，而 `next` 才是真版本——`dsh plugin add <name>` 会让所有人解析到意外结果。`dist-tag` 在踩坑前先标出矛盾（[讨论 #2763](https://github.com/deepseek-ai/deepseek-harness/discussions/2763) 的失败类别）。
- 最新版本几年没动、或没有许可证的依赖，在以每周千计增长的插件供应链里都是红旗。
- 没许可证、长期不更新不等于恶意——那是 poison-guard 的事。本插件负责供应链“健康饮食”这一半。

## 报告结构

每个检查带 `{ id, status, title, detail, items }`；`items` 是 `{ name, issue, level }`，`level` 为 `warn | fail`。schema 版本 `dsh-dep-audit/v1` 稳定、可给 CI 解析。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration
```

CI 跑 [dsh-plugin-doctor](https://github.com/zoahdev/dsh-plugin-doctor) 预检、单元测试、打包集成（真实安装 tarball 并调用真实 `dep_audit` handler）、以及 Windows 上全新 profile 的 `dsh web` 启动冒烟。

## 许可证

MIT © 2026 zoahdev