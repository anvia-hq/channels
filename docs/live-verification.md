# Live adapter verification

Packages stay private until this checklist passes against dedicated test bots. Never record tokens,
webhook secrets, private file URLs, or real user payloads in fixtures or logs.

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

## Publish gate

### One-time trusted publishing setup

1. On GitHub, under **Settings → Environments**, the `npmjs` environment has a `v*` tag policy and
   `indrazm` as the required reviewer — a dispatch waits for that approval before publishing.

2. On npmjs.com, configure a trusted publisher for each package (`@anvia/channel`,
   `@anvia/channel-agent`, `@anvia/discord`, `@anvia/slack`, `@anvia/telegram`):
   - Repository: `anvia-hq/channels`
   - Workflow: `release.yml`
   - Environment: `npmjs`
3. Versions are already set to `0.1.0`; publishing stays blocked while packages remain `private`.

### Per release

After the matrix passes:

1. Remove `private` only from packages intended for npm.
2. Inspect the generated tarballs (`pnpm --filter <package> pack --dry-run`); the release workflow
   prints them before publishing.
3. Confirm `dist` is generated from the reviewed commit and contains no credentials or fixtures.
4. Dispatch the release — GitHub → **Actions → Release → Run workflow** on `main`. The workflow
   refuses a stale `main`, runs the full gate, publishes with provenance, then tags the released
   version and creates the GitHub release. Commits and pushes made after dispatching are not
   published.

npm's CLI web-auth URLs are single-use: once an approval completes, reopening the URL returns 404.
A clean process exit means the operation succeeded regardless of how the URL behaves afterwards.
