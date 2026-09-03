# `@anvia/discord` guide

`@anvia/discord` provides a production-oriented `Channel` adapter backed by the Discord Gateway and
REST API. Start with `discord()` unless you are replacing its transport.

## Which utility should I use?

| Task                                                 | Utility                                                 |
| ---------------------------------------------------- | ------------------------------------------------------- |
| Normal application or agent                          | `discord()`                                             |
| Dependency-inject a custom gateway                   | `new DiscordChannel({ gateway })`                       |
| Use the built-in raw `discord.js` transport directly | `DiscordJsGateway`                                      |
| Implement a replacement transport                    | `DiscordGateway` interface                              |
| Normalize a validated gateway value                  | `normalizeDiscordEvent()`                               |
| Normalize only messages or actions                   | `normalizeDiscordMessage()`, `normalizeDiscordAction()` |
| Validate Discord IDs in application configuration    | `isDiscordSnowflake()`, `validateDiscordSnowflake()`    |

The low-level exports are extension points. A normal bot should not manually call a normalizer or
construct `DiscordJsGateway`.

## Configure the Discord application

1. Create an application and bot in the
   [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable **Message Content Intent** when the bot must read ordinary guild messages. The adapter
   requests that privileged intent by default.
3. Install the bot with `VIEW_CHANNEL`, `SEND_MESSAGES`, and `READ_MESSAGE_HISTORY`.
4. Add `SEND_MESSAGES_IN_THREADS` for thread replies, `ATTACH_FILES` for outbound files, and
   `ADD_REACTIONS` when using `channel.react()`.
5. Grant access only to the servers and channels the application should process.

Set `messageContentIntent: false` for a mention-only guild bot that does not have privileged intent
approval. Discord still supplies message content in direct messages, messages sent by the bot, and
messages that mention the bot. See Discord's official
[Gateway intent documentation](https://docs.discord.com/developers/events/gateway) and
[permission reference](https://docs.discord.com/developers/topics/permissions) for application
setup details.

## Create the adapter

```ts
import { discord } from "@anvia/discord";

const channel = discord({
  token: process.env.DISCORD_BOT_TOKEN!,
  messageContentIntent: true,
  maximumAttachmentBytes: 25 * 1024 * 1024,
  onError(error, context) {
    console.error("discord", context.operation, error);
  },
});
```

`maximumAttachmentBytes` caps each outbound file and the combined bytes buffered for one message.
The adapter downloads URL-backed outbound files sequentially and rejects redirects. Pass a custom
`fetch` that allowlists trusted hosts when attachment URLs are not controlled by your application.

## Send proactively

The REST delivery path does not require the Gateway to be started:

```ts
import { sendChannelMessage } from "@anvia/channel";

await sendChannelMessage(
  channel,
  {
    platform: "discord",
    conversationId: process.env.DISCORD_CHANNEL_ID!,
  },
  {
    text: "Deployment finished.",
    actions: [{ id: "deploy:details", label: "Details", style: "primary" }],
  },
);
```

Generated text is sent with Discord mentions disabled, preventing unexpected `@everyone`, role, or
user notifications.

## Receive normalized events

```ts
await channel.start(async (event) => {
  switch (event.type) {
    case "message":
      console.log(event.text, event.attachments, event.replyTo);
      break;
    case "action":
      console.log(event.actionId);
      break;
    case "message-edited":
    case "message-deleted":
    case "reaction":
      console.log(event.type, event.messageId);
      break;
  }
});
```

The adapter filters bot-authored events before application delivery. Gateway reaction objects from
uncached messages are fetched before normalization. Handler failures are reported through
`onError` without terminating the Gateway.

Gateway health surfaces through `onError`: shard disconnects, reconnect attempts, and invalidated
sessions (for example a revoked token) are all reported while discord.js keeps the connection
alive. Sessions are not resumed from before the outage; events emitted during the gap are lost.

## Threads and replies

Incoming threads use the parent channel as `conversation.id` and the Discord thread as
`conversation.threadId`. Preserve both when replying to a message event:

```ts
if (event.type !== "message") return;

const address: {
  platform: string;
  accountId?: string;
  conversationId: string;
  threadId?: string;
} = {
  platform: event.platform,
  conversationId: event.conversation.id,
};
if (event.accountId !== undefined) address.accountId = event.accountId;
if (event.conversation.threadId !== undefined) {
  address.threadId = event.conversation.threadId;
}

await channel.send(address, {
  text: "Replying inside the same thread.",
  replyToMessageId: event.raw.id,
});
```

`channel.send()` targets `threadId` when present. Discord message IDs and channel IDs must be valid
snowflakes.

## Attachments

Incoming Discord attachment metadata is normalized immediately. `channel.loadAttachment()` returns
only a Discord HTTPS CDN URL; it does not download inbound bytes into the application. The
channel-agent bridge consumes that URL when building a multimodal prompt.

Outbound attachments accept HTTPS URLs or base64 data. The combined Discord request is capped by
`maximumAttachmentBytes`, matching the adapter's memory bound.

## Agent integration

```ts
import { createChannelAgent } from "@anvia/channel-agent";

const service = createChannelAgent({ channel, agent });
await service.start();
```

Use `service.stop()`, not `channel.stop()`, when the service started the adapter.

## Low-level extension path

Use `DiscordGateway` when an existing application already owns a Discord connection:

```ts
import { DiscordChannel } from "@anvia/discord";
import type { DiscordGateway } from "@anvia/discord";

const gateway: DiscordGateway = existingGatewayAdapter;
const channel = new DiscordChannel({ gateway });
```

The custom gateway must emit runtime-validated `DiscordGatewayEvent` values, implement REST
operations required by the interface, and drain in-flight handlers during `stop()`.

## Shutdown

```ts
await channel.stop();
```

Stopping detaches Gateway listeners, destroys the Discord client, and waits for current event
deliveries. It is safe to call after a direct `channel.start()`; if a channel-agent owns the adapter,
stop the service instead.
