---
"@anvia/channel": minor
"@anvia/channel-agent": minor
---

Convert public helper and callback APIs from positional arguments to single request objects. Affected: `sendChannelMessage`, `splitChannelMessage`, `splitChannelText`, `channelMessagePrompt`, the `PartialDeliveryError` constructor, interaction store `take`/`delete`, and the `createPrompt`, `renderOutcome`, `render`, `parseResponse`, and `parseAction` callbacks. `ChannelAgentExecutor.resume` keeps its positional shape for `@anvia/core` `Agent` compatibility.
