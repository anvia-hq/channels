# `@anvia/discord`

Discord Gateway and text messaging adapter for Anvia Channels. It receives message-create events
through `discord.js` and sends or edits messages through Discord's rate-limit-aware REST client.

## Usage

```ts
import { discord } from "@anvia/discord";

const channel = discord({
  token: process.env.DISCORD_BOT_TOKEN!,
  onError(error, context) {
    // Send errors to your application logger or observability system.
  },
});

await channel.start(async (event) => {
  await channel.send(
    {
      platform: "discord",
      accountId: event.accountId,
      conversationId: event.conversation.id,
      threadId: event.conversation.threadId,
    },
    { text: `Received: ${event.text}` },
  );
});

// During graceful application shutdown:
await channel.stop();
```

The default Gateway intents receive guild messages, direct messages, and message content. Enable
the **Message Content Intent** on the application's Bot page in the Discord Developer Portal. For
a mention-only guild bot, set `messageContentIntent: false`; Discord still provides content in DMs
and messages that mention the bot.

Incoming Discord threads are represented by a parent `conversationId` and their own `threadId`.
Outbound mentions are disabled so agent-generated text cannot unexpectedly ping users or roles.
