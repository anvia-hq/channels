# `@anvia/telegram`

Telegram channel adapter for Anvia Channels.

The initial transport uses Telegram Bot API long polling, so local development does not require a
public HTTP endpoint. Webhook support is planned separately.

## Usage

```ts
import { sendChannelMessage } from "@anvia/channel";
import { telegram } from "@anvia/telegram";

const channel = telegram({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  onError(error, context) {
    // Send errors to your application logger or observability system.
  },
});

await channel.start(async (event) => {
  await sendChannelMessage(
    channel,
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
resolves. Incoming text, photos, documents, audio, voice messages, and video are delivered
sequentially. Media bytes are downloaded through `getFile` only when an application or agent loads
the attachment; the token-bearing Telegram download URL is never exposed to the model. Downloads
are stream-capped to 20 MiB by default; set `maximumAttachmentBytes` on `telegram(...)` to choose a
different application limit. Messages sent by bots and unsupported updates are acknowledged
without invoking the handler.
Portable message actions are rendered as inline keyboards. Callback queries are acknowledged
before application processing and normalized as action events.
`sendChannelMessage` splits long text into ordered messages at Telegram's boundary; `channel.send`
sends one atomic message and rejects oversized text.
