# @anvia/channel

## 0.5.0

### Minor Changes

- a438f6e: Upgrade to `@anvia/core` 1.21.0, add shared zero-dependency adapter utilities under `@anvia/channel/adapter`, and fix edge-case bugs across the channel runtime and adapters:

  - `@anvia/channel`: export `@anvia/channel/adapter` utilities (`readBoundedResponseBuffer`, `attachmentTypeFromMediaType`, `base64ByteLength`, `validateOutboundChannelMessage`, `BoundedSet`, `BoundedMap`, `reportChannelError`, `reportErrorSafely`) and preserve the `RawEvent` generic parameter on `createRateLimitedChannel`.
  - `@anvia/channel-agent`: update `@anvia/core` peer/dev range to `^1.21.0`, redact embedded credential values in approval previews via `@anvia/core/redaction`, ensure placeholder edits preserve actions when text matches streamed output, validate and report `PartialDeliveryError` on multi-part provisional deliveries, route interaction cancel store errors through `onError`, and propagate stream abort reasons accurately.
  - `@anvia/discord`: enforce full runtime payload validation in `normalizeDiscordCommand`, unify thread/conversation and attachment normalization, and decompose gateway internals.
  - `@anvia/slack`: enforce runtime payload validation in `normalizeSlackCommand`, eliminate unnecessary Base64 round-trips on outbound URL attachments, and decompose Socket Mode transport internals.
  - `@anvia/telegram`: retry HTTP 429 responses on multipart attachment uploads, handle pre-aborted signals during rate-limit waits, classify audio/video documents consistently by media type, and decompose parser and polling internals.

## 0.4.2

### Patch Changes

- de633dd: Fix `splitChannelMessage` to attach `replyToMessageId` to the first split part only, so a long reply sends one reply followed by continuations instead of N separate replies. Actions and attachments remain on the last part.

## 0.4.1

### Patch Changes

- 6a53d57: Refresh dependencies across the workspace and generate declarations with `tsc --emitDeclarationOnly` instead of tsup's bundled DTS step, which no longer works on TypeScript 7 (the native compiler exposes no `ts.sys`, and tsup injects the `baseUrl` option that TypeScript 7 removed). The public API surface is unchanged: every entry point still exports the same symbols. `@anvia/slack` picks up `@slack/web-api` 8.1.1, `@slack/socket-mode` 3.0.1 and `undici` 7.30.0.

## 0.4.0

### Minor Changes

- 09cf8a5: Complete the reaction lifecycle with unreact() and automatic acknowledgement cleanup, route Discord command responses through the interaction webhook, add per-command configuration, and add outbound rate limiting: Telegram 429 retries and createRateLimitedChannel().

## 0.3.0

### Minor Changes

- 2dae864: Add acknowledgement reactions (`acknowledge`) and cross-platform slash command handling (`commands`): a shared `ChannelCommandEvent` emitted by the Discord, Slack, and Telegram adapters, with opt-in routing through the channel-agent pipeline.

## 0.2.0

### Minor Changes

- fca9f3a: Convert public helper and callback APIs from positional arguments to single request objects. Affected: `sendChannelMessage`, `splitChannelMessage`, `splitChannelText`, `channelMessagePrompt`, the `PartialDeliveryError` constructor, interaction store `take`/`delete`, and the `createPrompt`, `renderOutcome`, `render`, `parseResponse`, and `parseAction` callbacks. `ChannelAgentExecutor.resume` keeps its positional shape for `@anvia/core` `Agent` compatibility.
