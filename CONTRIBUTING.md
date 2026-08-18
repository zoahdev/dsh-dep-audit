# Contributing

## Develop

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm pack
```

## Verify before pushing

- Unit tests must pass (vitest)
- The packed tarball must load and register its tool (scripts/integration-test.mjs)
- A fresh DSH profile must boot dsh web with the plugin (scripts/dsh-smoke.sh)

## Quality bar

- Zero runtime dependencies where possible
- Read-only by default; any write is an explicit opt-in
- Never print secret values
- Bilingual README + llms.txt
