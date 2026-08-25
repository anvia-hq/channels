# `@anvia/telegram`

Telegram channel adapter for Anvia Channels.

The initial transport uses Telegram Bot API long polling, so local development does not require a
public HTTP endpoint. Webhook support is planned separately.

## Usage

```ts
import { telegram } from "@anvia/telegram";

const channel = telegram({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  onError(error, context) {
    // Send errors to your application logger or observability system.
  },
});

await channel.start(async (event) => {
  await channel.send(
    {
      platform: "telegram",
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

Calling `start` verifies the token with `getMe`, starts polling in the background, and then
resolves. Incoming text messages are delivered sequentially. Messages sent by bots and unsupported
updates are acknowledged without invoking the handler.
