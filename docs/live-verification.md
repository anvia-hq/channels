# Live adapter verification

The libraries are published on npm. Use this checklist to record release evidence against
dedicated test bots. Never record tokens, webhook secrets, private file URLs, or real user payloads
in fixtures or logs. Offline checks alone do not establish live-platform readiness.

## Automated gate

Run from the repository root:

```sh
pnpm verify:release
```

The gate checks formatting, linting, strict types, builds every package, and runs the offline suite.

## Platform matrix

For Telegram, Discord, and Slack, verify:

- direct, group/channel, thread/topic, mention, and reply normalization;
- text, media-only, HTTPS-backed, and base64-backed outbound attachments;
- long-message splitting with actions and attachments on the final part;
- editing, deletion, reactions, and native action callbacks;
- agent streaming, typing where supported, multimodal prompts, approvals, and questions;
- invalid credentials, rate limits, handler failures, reconnects, duplicate delivery, and shutdown;
- outbound mention suppression and attachment size-limit failures.

Additionally verify Telegram polling and webhook modes independently, including a missing or invalid
secret header and a redelivered update. Verify Slack file uploads in both a root conversation and a
thread. Verify Discord with Message Content Intent enabled and disabled.

## Current verification record

Prepared 6 October 2026 against main `29cdf7e`. The runtime fixes in the delivery-recovery PR must
be merged and the tested revision/versions recorded before executing this matrix. No live platform
scenario was executed for this record: dedicated test-bot credentials and destinations are not
configured in the reviewed checkout (only `.env.example` templates are present).

| Scenario                                                          | Discord | Slack   | Telegram polling | Telegram webhook |
| ----------------------------------------------------------------- | ------- | ------- | ---------------- | ---------------- |
| Receive, route, mentions, direct/group/thread replies             | Not run | Not run | Not run          | Not run          |
| Commands, overlapping command replies, independent outbound sends | Not run | Not run | Not run          | Not run          |
| Attachments, media-only output, long text, file limits            | Not run | Not run | Not run          | Not run          |
| Streaming, edits, deletion, reactions, typing where supported     | Not run | Not run | Not run          | Not run          |
| Actions, approvals/questions, pending interaction restart         | Not run | Not run | Not run          | Not run          |
| Reconnect, rate limits, handler failure, duplicates, shutdown     | Not run | Not run | Not run          | Not run          |
| Platform-specific intents, uploads, or webhook authentication     | Not run | Not run | Not run          | Not run          |

For each execution, record the date, commit, installed versions, synthetic bot configuration, and
pass/fail/blocked result. Replace Not run only with observed evidence, link failures to focused work,
and describe omissions. Start with receive → agent → reply on each transport, then command overlap,
attachments, and recovery. Do not send to real customer conversations.

## 20 October 2026 package release validation

Validated Version Packages candidate `bced98a`, based on reviewed main `e67e80f` after PRs #38–#44.
The candidate consumes seven changesets and versions only the five public packages:

| Package                | Version |
| ---------------------- | ------- |
| `@anvia/channel`       | 0.4.2   |
| `@anvia/channel-agent` | 0.4.3   |
| `@anvia/discord`       | 0.3.3   |
| `@anvia/slack`         | 0.4.1   |
| `@anvia/telegram`      | 0.3.3   |

- `pnpm install --frozen-lockfile` passed without lockfile changes.
- `pnpm audit --prod --audit-level high` reported no known vulnerabilities.
- `pnpm verify:release` passed formatting, lint, typechecking, builds, 303 package tests, and
  18 offline release-script tests.
- `pnpm -r pack --dry-run` passed. The five public packages contain built JavaScript, source maps,
  declarations, package manifests, and README files; no credentials or platform fixtures are listed.
- The read-only release plan selected exactly these five unpublished versions, with no tag conflicts.
- GitHub's `npmjs` environment permits `main` and requires reviewer approval. The release workflow
  is unchanged from successful release run `38904280254`; npm trusted-publisher settings were not
  independently inspected. Publication authentication will be verified by the release workflow.
- No live-platform scenarios were run in this validation. The platform matrix above remains
  unverified; offline checks do not establish live-platform readiness.

## 23 November 2026 package release validation

Validated Version Packages candidate `b5d17ee`, based on reviewed `main` after PR #48 (delivery
recovery) merged. The candidate consumed four changesets — the Anvia 1.21.0 upgrade and refactor
plus the three interaction and delivery fixes — and versions only the five public packages:

| Package                | Version |
| ---------------------- | ------- |
| `@anvia/channel`       | 0.5.0   |
| `@anvia/channel-agent` | 0.5.0   |
| `@anvia/discord`       | 0.3.4   |
| `@anvia/slack`         | 0.4.2   |
| `@anvia/telegram`      | 0.3.4   |

- `pnpm install --frozen-lockfile` passed without lockfile changes.
- `pnpm verify:release` passed formatting, linting, strict typechecking, builds, 321 package tests
  (`@anvia/channel` 24, `@anvia/channel-agent` 85, `@anvia/discord` 47, `@anvia/slack` 81,
  `@anvia/telegram` 84) and 28 offline release-script and lint-plugin tests.
- `pnpm -r pack --dry-run` passed. The five public packages contain built JavaScript, source maps,
  declarations, package manifests, and README files; no credentials or platform fixtures are listed.
  `@anvia/channel` publishes `dist/adapter.js` and `dist/adapter.d.ts` behind the new `./adapter`
  subpath export.
- The read-only release plan selected exactly these five unpublished versions, with no tag
  conflicts and no publication from another revision.
- `pnpm audit --prod --audit-level high` reported 8 high and 6 moderate advisories, all transitive:
  `undici` 6.x through `discord.js → @discordjs/rest`, `undici` 7.x through `openai` in the
  examples, and `zod` below 4.6.6 through `@anvia/core` in the examples. None of them resolve to
  code in the published packages. This differs from the 20 October record, which reported a clean
  audit; closing it needs a `pnpm.overrides` follow-up for `undici` and `zod`.
- Release workflow run `45092156325` was dispatched from `b5d17ee` and passed every step. The
  protected `npmjs` environment required and received approval before publication; trusted
  publishing authenticated through OIDC, with no npm token involved.
- Publication was verified independently of the workflow log: the registry reports `channel` 0.5.0,
  `channel-agent` 0.5.0, `discord` 0.3.4, `slack` 0.4.2 and `telegram` 0.3.4 as `latest`; the five
  `@anvia/<name>@<version>` tags point at `b5d17ee`; a GitHub release exists for every tag; and the
  fetched tarballs contain the shipped fixes — the `./adapter` entry point in `@anvia/channel`, the
  handled and in-flight dedupe sets in `@anvia/slack`, and the reply fallback plus interaction
  reject paths in `@anvia/discord`.
- No live-platform scenario was run. The platform matrix above is still entirely Not run; an
  offline suite and a published tarball do not establish live-platform readiness. The Slack
  redelivery path and the Discord interaction-token fallback have only been exercised against fakes.
- The release log prints a benign `fatal: Needed a single revision` line for each tag the plan
  inspects before it exists; `scripts/release-packages.mjs` treats exit status 128 as "tag absent".

Code-level follow-ups from the same audit — conversation ordering under an async filter, the
non-expiring pending interaction, the SQLite interaction row that cannot be recovered, the Discord
thread identity split, and the Slack 75-character button label limit — are recorded on PR #48 and
are not part of this publication.

## Publish gate

Use [release and recovery](./releases.md) for trusted publisher configuration, independent package
tags, and retries after partial success. Live verification and package publication are separate
steps; a planning review or a green offline suite does not dispatch the release workflow.
