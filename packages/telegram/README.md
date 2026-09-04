# `@anvia/telegram`

See the [detailed Telegram guide](../../docs/telegram.md) for polling, webhooks, proactive delivery,
attachments, and agent integration.

Telegram channel adapter for Anvia Channels.

The default transport uses Telegram Bot API long polling, so local development does not require a
public HTTP endpoint. Hosted applications can instead pass validated webhook updates directly to
the channel.

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
  if (event.type !== "message") return;
  const address: {
    platform: string;
    accountId?: string;
    conversationId: string;
    threadId?: string;
  } = { platform: "telegram", conversationId: event.conversation.id };
  if (event.accountId !== undefined) address.accountId = event.accountId;
  if (event.conversation.threadId !== undefined) {
    address.threadId = event.conversation.threadId;
  }

  await sendChannelMessage({ channel, address, message: { text: `Received: ${event.text}` } });
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
before application processing and normalized as action events. `normalizeTelegramUpdate` returns an
event array because one Telegram reaction update can remove and add several reactions. Ordinary
emoji values are preserved; custom and paid reactions use `telegram:custom_emoji:<id>` and
`telegram:paid` portable values.
`sendChannelMessage` splits long text into ordered messages at Telegram's boundary; `channel.send`
validates one platform-sized logical delivery and rejects oversized text. A message with several
attachments uses multiple Bot API calls and may be partially delivered if an upload fails.

## Webhook transport

Configure Telegram's webhook URL separately, including the same secret token, and forward the
parsed request body plus the `X-Telegram-Bot-Api-Secret-Token` header:

```ts
const channel = telegram({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  webhook: { secretToken: process.env.TELEGRAM_WEBHOOK_SECRET! },
});
await channel.start(handler);

// Inside a Fetch-compatible POST route:
const body: unknown = await request.json();
const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? undefined;
await channel.receiveWebhook(body, secret);
```

Webhook payloads are runtime-validated before dispatch. Secret comparison is timing-safe. Do not
configure `polling` and `webhook` together.
