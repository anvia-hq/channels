# @anvia/telegram

## 0.3.2

### Patch Changes

- 0a411e2: Keep Discord deferred replies scoped to their originating command through asynchronous and queued handlers, preserve files in deferred replies, clean up unanswered deferrals, and propagate reply failures without duplicate fallback posts. Wait for an in-flight initial reply before handler cleanup and shutdown, including when a concurrent send fails. Preserve Telegram handler retries when malformed or out-of-order updates share a polling batch.

## 0.3.1

### Patch Changes

- 6a53d57: Refresh dependencies across the workspace and generate declarations with `tsc --emitDeclarationOnly` instead of tsup's bundled DTS step, which no longer works on TypeScript 7 (the native compiler exposes no `ts.sys`, and tsup injects the `baseUrl` option that TypeScript 7 removed). The public API surface is unchanged: every entry point still exports the same symbols. `@anvia/slack` picks up `@slack/web-api` 8.1.1, `@slack/socket-mode` 3.0.1 and `undici` 7.30.0.
- 7d815e5: Preserve replacement Telegram bot reactions when removing an earlier acknowledgement. Serialize reaction writes per message and clear only a matching reaction tracked by the channel instance; leave unknown reactions untouched and document Telegram's single-reaction and local-tracking limits.
- 00bd664: Make callback query acknowledgement best-effort in polling and webhook delivery. Report acknowledgement errors through onError without waiting for the observer to complete or blocking update handlers, subsequent updates, or retries after handler failures. Contain rejected observer promises.
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
