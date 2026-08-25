# `@anvia/channel-agent`

Connect an Anvia agent to any `@anvia/channel` adapter.

```ts
import { createChannelAgent } from "@anvia/channel-agent";

const service = createChannelAgent({
  channel,
  agent,
  streaming: {
    placeholder: "Thinking…",
    editIntervalMs: 750,
  },
  onError(error, context) {
    // Send errors to your application logger or observability system.
  },
});

await service.start();

// During graceful application shutdown:
await service.stop();
```

By default, the service handles direct messages and group messages that mention or reply to the
bot. Runs within one conversation or thread are serialized, while unrelated conversations may run
concurrently. The default Anvia memory scope is isolated by platform, bot account, conversation,
thread, and sender.

Streaming is enabled automatically when the agent model reports streaming support. Set
`streaming.enabled` explicitly to override detection. Set `streaming.placeholder` to `false` to
buffer the result and send only the final response.
