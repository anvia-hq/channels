# `@anvia/channel-agent` guide

`@anvia/channel-agent` connects one `Channel` adapter to one Anvia agent executor. Use it instead of
writing your own receive-filter-prompt-run-stream-send loop.

## Which utility should I use?

| Task                                                    | Utility                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Create a service and control startup yourself           | `createChannelAgent()`                                                        |
| Create and immediately start a service                  | `serveChannelAgent()`                                                         |
| Build the default multimodal prompt manually            | `channelMessagePrompt()`                                                      |
| Use the default sender-isolated memory scope explicitly | `channelConversationUserSession`                                              |
| Share memory across users in one conversation           | `channelConversationSession`                                                  |
| Inspect the stable queue/session key                    | `channelConversationKey()`                                                    |
| Customize whether a message is handled                  | `shouldHandle` or `defaultShouldHandleChannelEvent()`                         |
| Keep paused interactions in this process                | `MemoryChannelAgentInteractionStore`                                          |
| Keep paused interactions across restarts                | `SqliteChannelAgentInteractionStore`                                          |
| Customize approval/question presentation                | `renderChannelAgentInteraction()` and interaction options                     |
| Parse text or button interaction responses              | `parseChannelAgentInteractionResponse()`, `parseChannelAgentActionResponse()` |

Most applications need only `createChannelAgent()` and, when tools can pause for input, a durable
interaction store.

## Minimal service

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
    console.error(context.stage, error);
  },
});

await service.start();
```

The service starts the adapter, handles direct messages plus mentioned/replied group messages by
default, serializes runs inside one conversation/thread, streams text through message edits, splits
long final output, and stops the adapter when `service.stop()` is called.

Do not also call `channel.start()`. The service owns the adapter lifecycle.

## `createChannelAgent` or `serveChannelAgent`?

Use `createChannelAgent()` when application construction and startup are separate:

```ts
const service = createChannelAgent(options);
registerHealthChecks(service);
await service.start();
```

Use `serveChannelAgent()` for a small executable that wants an already-started service:

```ts
import { serveChannelAgent } from "@anvia/channel-agent";

const service = await serveChannelAgent({ channel, agent });
```

Both return `ChannelAgentService`; both must be stopped.

## Acknowledgement reactions

Set `acknowledge` to react to an incoming message the moment the service accepts it, before the
agent starts. Pass an emoji string for the common case:

```ts
const service = createChannelAgent({
  channel,
  agent,
  acknowledge: "👀",
});
```

The full form can add a second reaction on the same message once a final response is delivered:

```ts
const service = createChannelAgent({
  channel,
  agent,
  acknowledge: { reaction: "👀", completeReaction: "✅" },
});
```

Behaviour and limits:

- Reactions apply only to messages the service handles: bot-authored, lifecycle, and
  filtered-out events are never acknowledged.
- Reactions require `channel.capabilities.reactions === true` and `channel.react`. All three
  standard adapters (Discord, Slack, Telegram) support them; the service silently skips
  adapters that do not.
- The completion reaction is added only after a final response is delivered — not while an
  approval or question interaction is still pending. When a completion reaction is configured,
  the acceptance reaction is removed at the same time whenever the channel supports reaction
  removals (`capabilities.reactionRemovals`); set `clearOnCompletion: false` to keep it.
- A failed reaction is reported through `onError` with the `acknowledge` stage and never
  interrupts the agent run or the reply.
- Pass `acknowledge: false` (or omit it) to disable acknowledgements.

## Slash commands

Set `commands: true` to handle platform slash commands — Slack `/commands`, Discord application
commands, and Telegram bot commands. The agent runs with the prompt `/<name> <text>`:

```ts
const service = createChannelAgent({
  channel,
  agent,
  commands: true,
});

// Or decide per command:
const service = createChannelAgent({
  channel,
  agent,
  commands: {
    shouldHandle(event) {
      return event.name === "ask";
    },
  },
});
```

Notes per platform:

- **Slack**: register the command in your app config (Slash Commands) and run the app in Socket
  Mode; the payload arrives as a `slash_commands` envelope and is acknowledged automatically.
- **Discord**: register the application command (for example through the developer portal or a
  registration script). The gateway handles chat-input interactions; the reply is delivered as a
  regular channel message.
- **Telegram**: commands (`/ask@botname`, `/ask`) are messages with a `bot_command` entity; the
  adapter emits a `command` event for those addressed to this bot and publishes the command list
  through BotFather or `setMyCommands`.

Bot-authored commands are always ignored, and commands run through the same pipeline as messages:
filtering, acknowledgement reactions, sessions, streaming, and interactions all apply.

## Filtering

The default filter handles:

- direct messages;
- group/channel messages that mention the bot;
- group/channel messages that reply to the bot.

Override `shouldHandle` for product-specific routing:

```ts
const service = createChannelAgent({
  channel,
  agent,
  shouldHandle(event) {
    return event.conversation.kind === "direct" || event.text.startsWith("/ask ");
  },
});
```

Bot-authored events and lifecycle events do not start agent runs.

## Prompt and attachment policy

The default prompt stays a string for text-only messages and becomes multimodal content when files
are present. The adapter loads authenticated bytes only during prompt preparation.

```ts
const service = createChannelAgent({
  channel,
  agent,
  multimodal: {
    maximumAttachments: 5,
    maximumAttachmentBytes: 10 * 1024 * 1024,
    maximumTotalAttachmentBytes: 25 * 1024 * 1024,
    attachmentConcurrency: 2,
  },
});
```

Use `channelMessagePrompt()` inside a custom prompt builder so custom instructions do not
accidentally discard attachments:

```ts
import { channelMessagePrompt, createChannelAgent } from "@anvia/channel-agent";

const service = createChannelAgent({
  channel,
  agent,
  async createPrompt(request) {
    return channelMessagePrompt({
      channel: request.context.channel,
      event: request.event,
      signal: request.context.abortSignal,
      maximumAttachments: 3,
    });
  },
});
```

Set `multimodal: false` to reject attachment-bearing input before the model runs.

## Conversation memory scope

This package chooses the `MemoryScope` passed to the agent; the agent's memory store is configured
through `@anvia/core`.

| Product behavior                              | `createSession` value                           |
| --------------------------------------------- | ----------------------------------------------- |
| Each sender has private history in a group    | omit it or use `channelConversationUserSession` |
| Everyone in one channel/thread shares history | `channelConversationSession`                    |
| No memory for an event                        | custom function returning `undefined`           |
| Custom tenant/user mapping                    | custom function returning your `MemoryScope`    |

```ts
import { channelConversationSession } from "@anvia/channel-agent";

const service = createChannelAgent({ channel, agent, createSession: channelConversationSession });
```

## Streaming and rich output

Streaming is enabled automatically when the agent model advertises it. Disable the placeholder to
buffer and send only the final response:

```ts
const service = createChannelAgent({
  channel,
  agent,
  streaming: { placeholder: false },
});
```

`renderOutcome` may return a string or a complete `ChannelMessage`:

```ts
const service = createChannelAgent({
  channel,
  agent,
  renderOutcome({ outcome }) {
    if (outcome.type !== "response") return outcome.text;

    return {
      text: outcome.text,
      attachments: [
        {
          type: "file",
          mediaType: "application/json",
          filename: "result.json",
          source: {
            type: "data",
            data: Buffer.from(JSON.stringify(outcome.output)).toString("base64"),
          },
        },
      ],
    };
  },
});
```

The standard attachment-capable adapters can delete the streaming placeholder before delivering a
rich final message. For a custom attachment-capable adapter without deletion support, the service
skips the placeholder.

## Approvals and questions

When an Anvia run pauses for tool approval or a tool question, the service stores its continuation
server-side. Native buttons are used when `channel.capabilities.actions` is true; text replies remain
the fallback.

For development or terminal interactions within one process, the default memory store is enough.
For a restart-safe service, use SQLite:

```ts
import { SqliteChannelAgentInteractionStore, createChannelAgent } from "@anvia/channel-agent";

const interactionStore = new SqliteChannelAgentInteractionStore({
  database: "data/channel-interactions.sqlite",
});

const service = createChannelAgent({
  channel,
  agent,
  interactions: {
    store: interactionStore,
    invalidResponseMessage: "Choose one of the available answers.",
  },
});
```

Interaction storage and conversation memory are different:

- conversation memory preserves chat history and belongs to the agent;
- interaction storage preserves a paused continuation and belongs to the channel-agent service.

Keep externally mutating tools idempotent. Claiming a continuation is atomic, but a retry after a
process or network failure cannot guarantee exactly-once side effects.

Pending interactions can expire, be cancelled, and fail safely:

- `interactions.timeoutMs` drops a pending interaction after the given delay; expired pendings are
  treated as absent for replies and button clicks.
- Replying with `cancel` (configurable or disabled with `interactions.cancelKeyword`) abandons the
  pending interaction and confirms with `interactions.cancelMessage`.
- If rendering or delivering an interaction prompt fails, the pending interaction is rolled back so
  a prompt the user never saw can never be resumed by a later reply.
- On shutdown, an already-sent streaming placeholder is deleted (or replaced with a short
  "(interrupted)" note) instead of being left dangling.

## Graceful shutdown

Stop the service before closing the databases it may still use:

```ts
try {
  await service.stop();
} finally {
  interactionStore.close();
  await memoryClient.close();
}
```

`stop()` aborts new work, stops the adapter, and drains queued conversations. Make shutdown
idempotent when registering both `SIGINT` and `SIGTERM` handlers.
