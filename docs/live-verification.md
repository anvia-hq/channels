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

## Publish gate

Use [release and recovery](./releases.md) for trusted publisher configuration, independent package
tags, and retries after partial success. Live verification and package publication are separate
steps; a planning review or a green offline suite does not dispatch the release workflow.
