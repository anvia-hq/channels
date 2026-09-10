# @anvia/channel-agent

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
