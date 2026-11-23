# @anvia/discord

## 0.3.4

### Patch Changes

- a438f6e: Upgrade to `@anvia/core` 1.21.0, add shared zero-dependency adapter utilities under `@anvia/channel/adapter`, and fix edge-case bugs across the channel runtime and adapters:

  - `@anvia/channel`: export `@anvia/channel/adapter` utilities (`readBoundedResponseBuffer`, `attachmentTypeFromMediaType`, `base64ByteLength`, `validateOutboundChannelMessage`, `BoundedSet`, `BoundedMap`, `reportChannelError`, `reportErrorSafely`) and preserve the `RawEvent` generic parameter on `createRateLimitedChannel`.
  - `@anvia/channel-agent`: update `@anvia/core` peer/dev range to `^1.21.0`, redact embedded credential values in approval previews via `@anvia/core/redaction`, ensure placeholder edits preserve actions when text matches streamed output, validate and report `PartialDeliveryError` on multi-part provisional deliveries, route interaction cancel store errors through `onError`, and propagate stream abort reasons accurately.
  - `@anvia/discord`: enforce full runtime payload validation in `normalizeDiscordCommand`, unify thread/conversation and attachment normalization, and decompose gateway internals.
  - `@anvia/slack`: enforce runtime payload validation in `normalizeSlackCommand`, eliminate unnecessary Base64 round-trips on outbound URL attachments, and decompose Socket Mode transport internals.
  - `@anvia/telegram`: retry HTTP 429 responses on multipart attachment uploads, handle pre-aborted signals during rate-limit waits, classify audio/video documents consistently by media type, and decompose parser and polling internals.

- 922c614: Acknowledge every incoming interaction. Unsupported interaction types (context menus, select
  menus, modal submits) and interactions whose payload cannot be read now get an ephemeral reply and
  are reported through `onError` instead of showing "This interaction failed" while the application
  stays blind. Autocomplete interactions are answered with an empty result, and a rejected
  `deferReply`/`deferUpdate` is reported instead of silently dropping the command or button click.
- c0cd68d: Deliver a channel post when a deferred command reply cannot be edited, and serialize concurrent
  sends inside one command handler. An expired interaction token, a deleted placeholder message or a
  Discord error used to discard the agent's whole answer and delete the deferred reply; the failure is
  now reported through `onError` and the answer is posted to the channel instead.
- Updated dependencies [a438f6e]
  - @anvia/channel@0.5.0

## 0.3.3

### Patch Changes

- Updated dependencies [de633dd]
  - @anvia/channel@0.4.2

## 0.3.2

### Patch Changes

- 0a411e2: Keep Discord deferred replies scoped to their originating command through asynchronous and queued handlers, preserve files in deferred replies, clean up unanswered deferrals, and propagate reply failures without duplicate fallback posts. Wait for an in-flight initial reply before handler cleanup and shutdown, including when a concurrent send fails. Preserve Telegram handler retries when malformed or out-of-order updates share a polling batch.

## 0.3.1

### Patch Changes

- 6a53d57: Refresh dependencies across the workspace and generate declarations with `tsc --emitDeclarationOnly` instead of tsup's bundled DTS step, which no longer works on TypeScript 7 (the native compiler exposes no `ts.sys`, and tsup injects the `baseUrl` option that TypeScript 7 removed). The public API surface is unchanged: every entry point still exports the same symbols. `@anvia/slack` picks up `@slack/web-api` 8.1.1, `@slack/socket-mode` 3.0.1 and `undici` 7.30.0.
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
