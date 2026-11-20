---
"@anvia/channel": minor
"@anvia/channel-agent": minor
"@anvia/discord": patch
"@anvia/slack": patch
"@anvia/telegram": patch
---

Upgrade to `@anvia/core` 1.21.0, add shared zero-dependency adapter utilities under `@anvia/channel/adapter`, and fix edge-case bugs across the channel runtime and adapters:

- `@anvia/channel`: export `@anvia/channel/adapter` utilities (`readBoundedResponseBuffer`, `attachmentTypeFromMediaType`, `base64ByteLength`, `validateOutboundChannelMessage`, `BoundedSet`, `BoundedMap`, `reportChannelError`, `reportErrorSafely`) and preserve the `RawEvent` generic parameter on `createRateLimitedChannel`.
- `@anvia/channel-agent`: update `@anvia/core` peer/dev range to `^1.21.0`, redact embedded credential values in approval previews via `@anvia/core/redaction`, ensure placeholder edits preserve actions when text matches streamed output, validate and report `PartialDeliveryError` on multi-part provisional deliveries, route interaction cancel store errors through `onError`, and propagate stream abort reasons accurately.
- `@anvia/discord`: enforce full runtime payload validation in `normalizeDiscordCommand`, unify thread/conversation and attachment normalization, and decompose gateway internals.
- `@anvia/slack`: enforce runtime payload validation in `normalizeSlackCommand`, eliminate unnecessary Base64 round-trips on outbound URL attachments, and decompose Socket Mode transport internals.
- `@anvia/telegram`: retry HTTP 429 responses on multipart attachment uploads, handle pre-aborted signals during rate-limit waits, classify audio/video documents consistently by media type, and decompose parser and polling internals.
