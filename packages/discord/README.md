# `@anvia/discord`

Discord Gateway and messaging adapter for Anvia Channels. It receives message-create events
through `discord.js` and sends or edits text through Discord's rate-limit-aware REST client.

## Usage

```ts
import { sendChannelMessage } from "@anvia/channel";
import { discord } from "@anvia/discord";

const channel = discord({
  token: process.env.DISCORD_BOT_TOKEN!,
  onError(error, context) {
    // Send errors to your application logger or observability system.
  },
});

await channel.start(async (event) => {
  if (event.type !== "message") return;
  await sendChannelMessage(
    channel,
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
Incoming images, audio, video, and other files are exposed as normalized attachments. Attachment
loading returns Discord's HTTPS CDN URL without downloading the file into application memory.
Outbound mentions are disabled so agent-generated text cannot unexpectedly ping users or roles.
Portable message actions are rendered as Discord buttons, and button interactions are acknowledged
before application processing.
Outbound attachments, replies, typing indicators, reactions, and message deletion use Discord's
REST API. Gateway message edits, deletions, and reaction changes are normalized as lifecycle events.
Partial reaction objects from uncached messages are resolved before delivery. Outbound files are
downloaded sequentially, and `maximumAttachmentBytes` caps both each file and the combined bytes
buffered for one Discord message.
`sendChannelMessage` splits long text into ordered messages at Discord's boundary; `channel.send`
validates one platform-sized logical delivery and rejects oversized text.
