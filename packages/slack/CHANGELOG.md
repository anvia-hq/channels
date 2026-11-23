# @anvia/slack

## 0.4.3

### Patch Changes

- 266b195: Require `undici` `^7.30.1`, the first release without the cache poisoning, TLS validation, and
  WebSocket denial-of-service advisories that affect `7.30.0`.

## 0.4.2

### Patch Changes

- a438f6e: Upgrade to `@anvia/core` 1.21.0, add shared zero-dependency adapter utilities under `@anvia/channel/adapter`, and fix edge-case bugs across the channel runtime and adapters:

  - `@anvia/channel`: export `@anvia/channel/adapter` utilities (`readBoundedResponseBuffer`, `attachmentTypeFromMediaType`, `base64ByteLength`, `validateOutboundChannelMessage`, `BoundedSet`, `BoundedMap`, `reportChannelError`, `reportErrorSafely`) and preserve the `RawEvent` generic parameter on `createRateLimitedChannel`.
  - `@anvia/channel-agent`: update `@anvia/core` peer/dev range to `^1.21.0`, redact embedded credential values in approval previews via `@anvia/core/redaction`, ensure placeholder edits preserve actions when text matches streamed output, validate and report `PartialDeliveryError` on multi-part provisional deliveries, route interaction cancel store errors through `onError`, and propagate stream abort reasons accurately.
  - `@anvia/discord`: enforce full runtime payload validation in `normalizeDiscordCommand`, unify thread/conversation and attachment normalization, and decompose gateway internals.
  - `@anvia/slack`: enforce runtime payload validation in `normalizeSlackCommand`, eliminate unnecessary Base64 round-trips on outbound URL attachments, and decompose Socket Mode transport internals.
  - `@anvia/telegram`: retry HTTP 429 responses on multipart attachment uploads, handle pre-aborted signals during rate-limit waits, classify audio/video documents consistently by media type, and decompose parser and polling internals.

- ad81dcc: Record Socket Mode deduplication keys only after a message is fully handled. A handler failure no
  longer marks the message as delivered, so a redelivery or the paired `app_mention`/`message`
  envelope can still start the run instead of the message being lost for good.
- Updated dependencies [a438f6e]
  - @anvia/channel@0.5.0

## 0.4.1

### Patch Changes

- 4276f7a: Deduplicate Slack message and app_mention callbacks by workspace, channel, and message timestamp to prevent double replies. Preserve event redelivery suppression and separate lifecycle, command, and interaction identities.
- 35d65e7: Fix `SlackChannel.splitMessage` to keep `replyToMessageId` on every split part, so long replies keep all continuations in the reply thread instead of dropping them to the channel top level.
- Updated dependencies [de633dd]
  - @anvia/channel@0.4.2

## 0.4.0

### Minor Changes

- 2994ce7: Publish Slack attachments and accompanying text or actions as one file message, cleaning up known uploads on failure. Preserve file IDs in sent message handles so deletion removes the files and message across retries and process restarts.

  File-message IDs are now opaque handles rather than bare timestamps. Custom `SlackWebClient` implementations must replace `uploadFile` with `postFileMessage` and `deleteFile`; custom transports can return `SlackSentMessage.fileIds` and accept them as the optional third argument to `delete`. Outbound file messages require `files:read` as well as `files:write` to resolve the sent timestamp.

### Patch Changes

- 6a53d57: Refresh dependencies across the workspace and generate declarations with `tsc --emitDeclarationOnly` instead of tsup's bundled DTS step, which no longer works on TypeScript 7 (the native compiler exposes no `ts.sys`, and tsup injects the `baseUrl` option that TypeScript 7 removed). The public API surface is unchanged: every entry point still exports the same symbols. `@anvia/slack` picks up `@slack/web-api` 8.1.1, `@slack/socket-mode` 3.0.1 and `undici` 7.30.0.
- 2af9f6f: Require HTTPS for Slack file download URLs so bot credentials are never sent over plaintext HTTP.
- Updated dependencies [6a53d57]
  - @anvia/channel@0.4.1

## 0.3.0

### Minor Changes

- 09cf8a5: Complete the reaction lifecycle with unreact() and automatic acknowledgement cleanup, route Discord command responses through the interaction webhook, add per-command configuration, and add outbound rate limiting: Telegram 429 retries and createRateLimitedChannel().

### Patch Changes

- Updated dependencies [09cf8a5]
  - @anvia/channel@0.4.0

## 0.2.0

### Minor Changes

- 2dae864: Add acknowledgement reactions (`acknowledge`) and cross-platform slash command handling (`commands`): a shared `ChannelCommandEvent` emitted by the Discord, Slack, and Telegram adapters, with opt-in routing through the channel-agent pipeline.

### Patch Changes

- Updated dependencies [2dae864]
  - @anvia/channel@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [fca9f3a]
  - @anvia/channel@0.2.0
