# @anvia/channel

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
