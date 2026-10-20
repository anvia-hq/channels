# @anvia/channel-agent

## 0.4.3

### Patch Changes

- bfa01ac: Fix attachment delivery with a streaming placeholder to delete the provisional placeholder when `sendChannelMessage` throws `PartialDeliveryError`, so a failed attachment send no longer leaves a dangling "Thinking…" message. The error still propagates to the existing delivery error reporting unchanged.
- d0c3f17: Bound channel agent runs with a configurable execution timeout (`runTimeoutMs`, default five minutes). A hung `generate`, `stream`, or `resume` call now aborts its run signal and reports through the existing `agent`-stage error path instead of wedging the conversation queue or `stop()`.
- Updated dependencies [de633dd]
  - @anvia/channel@0.4.2

## 0.4.2

### Patch Changes

- 6a53d57: Refresh dependencies across the workspace and generate declarations with `tsc --emitDeclarationOnly` instead of tsup's bundled DTS step, which no longer works on TypeScript 7 (the native compiler exposes no `ts.sys`, and tsup injects the `baseUrl` option that TypeScript 7 removed). The public API surface is unchanged: every entry point still exports the same symbols. `@anvia/slack` picks up `@slack/web-api` 8.1.1, `@slack/socket-mode` 3.0.1 and `undici` 7.30.0.
- c126c8c: Finish delivering successful interaction resume outcomes during shutdown so completed results are not discarded and pending prompts match what users received.
  Keep the channel open until queued outcomes and placeholder cleanup finish, then stop the adapter.
- Updated dependencies [6a53d57]
  - @anvia/channel@0.4.1

## 0.4.1

### Patch Changes

- Export the `ChannelAgentCommandHandler` type from the package entrypoint so per-command handler overrides can be imported.

## 0.4.0

### Minor Changes

- 09cf8a5: Complete the reaction lifecycle with unreact() and automatic acknowledgement cleanup, route Discord command responses through the interaction webhook, add per-command configuration, and add outbound rate limiting: Telegram 429 retries and createRateLimitedChannel().

### Patch Changes

- Updated dependencies [09cf8a5]
  - @anvia/channel@0.4.0

## 0.3.0

### Minor Changes

- 2dae864: Add acknowledgement reactions (`acknowledge`) and cross-platform slash command handling (`commands`): a shared `ChannelCommandEvent` emitted by the Discord, Slack, and Telegram adapters, with opt-in routing through the channel-agent pipeline.

### Patch Changes

- Updated dependencies [2dae864]
  - @anvia/channel@0.3.0

## 0.2.0

### Minor Changes

- fca9f3a: Convert public helper and callback APIs from positional arguments to single request objects. Affected: `sendChannelMessage`, `splitChannelMessage`, `splitChannelText`, `channelMessagePrompt`, the `PartialDeliveryError` constructor, interaction store `take`/`delete`, and the `createPrompt`, `renderOutcome`, `render`, `parseResponse`, and `parseAction` callbacks. `ChannelAgentExecutor.resume` keeps its positional shape for `@anvia/core` `Agent` compatibility.

### Patch Changes

- Updated dependencies [fca9f3a]
  - @anvia/channel@0.2.0
