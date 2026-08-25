# AGENTS.md

## Project shape

Anvia Channels is a strict TypeScript pnpm workspace for communication-channel adapters, Anvia
agent integration, and proactive outbound delivery.

Workspace packages live in `packages/*`. Use pnpm from the repository root.

## Before editing

- Run `git status --short --branch` before changing files.
- Keep platform SDK behavior inside its adapter package.
- Keep `@anvia/channel` independent of `@anvia/core` and platform SDKs.
- Do not commit credentials, bot tokens, webhook secrets, or real platform payloads.
- Do not edit generated `dist/`, coverage, or `node_modules/` files.

## Commands

```sh
pnpm check
pnpm check:fix
pnpm typecheck
pnpm test
pnpm build
```

## Style

- TypeScript is strict, ESM, and targets ES2022.
- Oxlint owns linting and Oxfmt owns formatting.
- Use explicit public types and validate all external platform payloads at runtime.
- Unit tests must not require live platform credentials or network access.
