# Contributing to Anvia Channels

Thanks for taking the time to improve Anvia Channels. This project is a strict TypeScript pnpm
workspace for communication-channel adapters, Anvia agent integration, and proactive outbound
delivery.

## Before You Start

- Read [README.md](README.md) for the package list, usage patterns, and example setup.
- Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) in all project spaces.

## Contribution Scope

Good contributions usually fall into one of these areas:

- Core channel contract fixes in `packages/channel`.
- Agent bridge fixes or features in `packages/channel-agent`.
- Platform adapter fixes in `packages/discord`, `packages/slack`, and `packages/telegram`.
- Documentation updates in package READMEs and `docs/*`.
- Tests that capture bugs, edge cases, or public behavior.
- Example improvements under `examples/*`.

Keep changes scoped. Avoid mixing dependency updates, formatting churn, generated output, and
feature work unless they are needed for the same change.

## Workflow

1. Create a branch from the current main development branch.
2. Install dependencies with `pnpm install`.
3. Make the smallest coherent change.
4. Add or update tests for behavior changes.
5. Run the relevant package checks while developing.
6. Run workspace validation before opening a pull request.

```sh
pnpm typecheck
pnpm test
pnpm check
```

For package-scoped work, prefer filtered commands during iteration:

```sh
pnpm --filter @anvia/channel typecheck
pnpm --filter @anvia/channel-agent test
pnpm --filter @anvia/telegram typecheck
```

## Pull Requests

Pull requests should include:

- A clear summary of what changed and why.
- The validation commands you ran.
- Any known limitations or follow-up work.
- Notes for breaking changes, migration needs, or dependency updates.

Before requesting review, make sure:

- `pnpm-lock.yaml` is updated only when dependencies changed.
- Generated files are either intentionally committed or left untouched.
- Public API changes include docs updates and a changeset.
- New package exports are reflected in the package `exports` map.

## Changesets

Public package behavior changes must include a changeset created with `pnpm changeset`:

- `patch` for bug fixes and small behavior fixes.
- `minor` for new backwards-compatible APIs, features, options, or exports.
- `minor` for breaking API or type changes while packages are pre-1.0.
- `major` for breaking changes after 1.0.

Do not add a changeset for docs-only, CI, or example-only changes.

## Code Style

- Use TypeScript and existing project patterns: strict, ESM, ES2022.
- Keep public APIs explicit and stable. Validate all external platform payloads at runtime.
- Keep platform SDK behavior inside its adapter package.
- Keep `@anvia/channel` independent of `@anvia/core` and platform SDKs.
- Use Oxlint and Oxfmt through the existing scripts rather than invoking them ad hoc.
- Avoid unrelated refactors in bug-fix pull requests.

## Tests

Tests live beside the package they cover, under `test/`. Use focused tests for narrow fixes and
broader coverage when changing shared behavior.

Run all tests before larger changes:

```sh
pnpm test
```

Unit tests must not require live platform credentials or network access. Behavior changes that
only live-platform verification can confirm should be noted in
[docs/live-verification.md](docs/live-verification.md).

## Dependency Updates

When updating dependencies:

- Prefer explicit package-scoped `pnpm --filter ... add package@^version` commands.
- Run `pnpm typecheck` and `pnpm test` afterward.
- Call out major upstream updates in the pull request.

## Reporting Bugs

Bug reports should include:

- The package or example affected.
- A minimal reproduction or failing test case.
- Expected behavior and actual behavior.
- Node.js and pnpm versions.
- Relevant platform details (Discord, Slack, or Telegram) and adapter options in use.

Do not include bot tokens, app tokens, API keys, secrets, or real platform payloads in issues,
pull requests, logs, screenshots, or traces.

## Security

If you find a security issue, do not open a public issue with exploit details. Contact the
maintainers privately with the smallest useful reproduction and impact description.

Security-sensitive areas include credential handling, polling and webhook transports, socket
transports, inbound payload normalization, attachment loading, interaction continuation storage,
and any code that handles user-controlled platform input.
