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

After the matrix passes:

1. Replace `0.0.0` with the chosen initial version and remove `private` only from packages intended
   for npm.
2. Inspect every generated tarball with `pnpm --filter <package> pack --dry-run`.
3. Confirm `dist` is generated from the reviewed commit and contains no credentials or fixtures.
4. Publish with provenance from the release workflow, then install each package into an empty test
   project and run one send/receive smoke test.
