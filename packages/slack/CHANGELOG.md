# @anvia/slack

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
