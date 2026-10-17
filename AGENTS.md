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

## Changesets And Releases

Changesets are configured in `.changeset/config.json`. Public packages in `packages/*` version
independently, with no fixed or linked groups. Private packages are not versioned; internal
dependents receive patch bumps when required.

For public package behavior changes, add or update a changeset targeting the owning package unless
the user or maintainer explicitly says not to. Do not run versioning, publishing, tagging, GitHub
release, or deployment commands (including `pnpm version-packages`, `changeset version`,
`npm publish`, `git tag`, or dispatching `release.yml`) unless explicitly requested.

### Release Flow

1. Changesets land on `main`.
2. `.github/workflows/version-packages.yml` opens or updates the **Version Packages** PR from
   `changeset-release/main`. It uses `GITHUB_TOKEN`, so close and reopen the PR to start CI. Merge
   after confirming it versions only the intended packages and required dependents.
3. Manually dispatch `.github/workflows/release.yml` (`workflow_dispatch`) from current `main`.
   It runs `scripts/release-packages.mjs` to publish missing versions through npm Trusted Publishing
   (OIDC, `npmjs` environment, no npm tokens) and create `<package-name>@<version>` tags and GitHub
   releases.

See `docs/releases.md` for details and recovery.

## Pull Request Expectations

Before handing work back, report:

- What changed.
- Which validation commands ran (`pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build`).
- Any validation skipped and why.
- Any generated files intentionally changed.
