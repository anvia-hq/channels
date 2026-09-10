# @anvia/channel

## 0.4.0

### Minor Changes

- 09cf8a5: Complete the reaction lifecycle with unreact() and automatic acknowledgement cleanup, route Discord command responses through the interaction webhook, add per-command configuration, and add outbound rate limiting: Telegram 429 retries and createRateLimitedChannel().

## 0.3.0

### Minor Changes

- 2dae864: Add acknowledgement reactions (`acknowledge`) and cross-platform slash command handling (`commands`): a shared `ChannelCommandEvent` emitted by the Discord, Slack, and Telegram adapters, with opt-in routing through the channel-agent pipeline.

## 0.2.0

### Minor Changes

- fca9f3a: Convert public helper and callback APIs from positional arguments to single request objects. Affected: `sendChannelMessage`, `splitChannelMessage`, `splitChannelText`, `channelMessagePrompt`, the `PartialDeliveryError` constructor, interaction store `take`/`delete`, and the `createPrompt`, `renderOutcome`, `render`, `parseResponse`, and `parseAction` callbacks. `ChannelAgentExecutor.resume` keeps its positional shape for `@anvia/core` `Agent` compatibility.
