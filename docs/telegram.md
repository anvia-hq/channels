# `@anvia/telegram` guide

`@anvia/telegram` provides Bot API delivery plus two receive modes: long polling and application-
hosted webhooks. Start with `telegram()` unless you need the validated Bot API client directly.

## Which utility should I use?

| Task                                           | Utility                                                 |
| ---------------------------------------------- | ------------------------------------------------------- |
| Normal polling bot or proactive sender         | `telegram()`                                            |
| Hosted webhook bot                             | `telegram({ webhook })` plus `channel.receiveWebhook()` |
| Supply a fake or custom API client             | `telegram({ api })`                                     |
| Call validated Bot API operations directly     | `createTelegramBotApiClient()`                          |
| Validate an unknown Telegram update            | `parseTelegramUpdate()`                                 |
| Convert a validated update into channel events | `normalizeTelegramUpdate()`                             |
| Handle structured API failures                 | `TelegramApiError`                                      |

`normalizeTelegramUpdate()` returns an array because one Telegram reaction update may produce
several removed/added `ChannelReactionEvent` values.

## Create the bot

Create a bot with [BotFather](https://t.me/BotFather), copy its token into a secret manager, and
choose one receive mode:

- long polling for workers, local development, and processes without a public HTTP route;
- webhook delivery for an existing HTTPS application server.

Telegram cannot deliver through `getUpdates` while a webhook is configured. Remove the webhook
before switching a bot back to polling. See the official
[Telegram Bot API](https://core.telegram.org/bots/api) for bot creation, webhook registration, and
delivery requirements.

## Long polling

Polling is the default:

```ts
import { telegram } from "@anvia/telegram";

const channel = telegram({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  polling: {
    timeoutSeconds: 30,
    retryDelayMs: 1_000,
    limit: 100,
  },
  maximumAttachmentBytes: 20 * 1024 * 1024,
  onError(error, context) {
    console.error("telegram", context.operation, error);
  },
});

await channel.start(handler);
```

`start()` validates the token with `getMe`, then starts the background polling loop. Successfully
handled updates advance the offset; handler failures are reported and retried.

## Webhook delivery

The adapter validates a secret configured by your application. Configure the same secret with
Telegram's `setWebhook` call and forward the request body and
`X-Telegram-Bot-Api-Secret-Token` header:

```ts
const channel = telegram({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  webhook: { secretToken: process.env.TELEGRAM_WEBHOOK_SECRET! },
});

await channel.start(handler);

// Inside a Fetch-compatible POST handler:
const payload: unknown = await request.json();
const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? undefined;
await channel.receiveWebhook(payload, secret);
return new Response(null, { status: 204 });
```

The package does not register the external webhook URL for you. That remains deployment
configuration because this adapter does not know the application's public route. Concurrent
redeliveries of one update share the same in-flight handler execution. Return a non-2xx response
when `receiveWebhook()` rejects so Telegram can retry.

Do not provide both `polling` and `webhook` options.

## Send proactively

Bot API delivery does not require the receive loop to be started:

```ts
import { sendChannelMessage } from "@anvia/channel";

await sendChannelMessage(
  channel,
  { platform: "telegram", conversationId: "-1001234567890", threadId: "42" },
  {
    text: "Release candidate ready.",
    replyToMessageId: "1234",
    actions: [
      { id: "release:approve", label: "Approve", style: "primary" },
      { id: "release:deny", label: "Deny", style: "danger" },
    ],
  },
);
```

Numeric chat IDs may be negative. Public channel targets may use an `@username`. Message IDs and
topic IDs must be positive safe integers represented as strings in the shared channel API.

## Receive normalized events

```ts
await channel.start(async (event) => {
  if (event.type === "message") {
    console.log(event.text, event.attachments, event.replyTo);
  }
  if (event.type === "reaction") {
    console.log(event.reaction, event.removed);
  }
});
```

Ordinary reaction emoji are preserved. Custom and paid reaction values are represented as
`telegram:custom_emoji:<id>` and `telegram:paid`. Anonymous reactions use the acting chat as the
normalized sender.

## Attachments

Incoming Telegram events expose file IDs as normalized metadata. `channel.loadAttachment()` calls
`getFile`, downloads through the token-bearing URL internally, stream-caps the response, and returns
base64 data. Authenticated URLs are never exposed to callers or models.

Outbound files may use base64 data or HTTPS URLs. Telegram downloads URL sources itself; base64
sources are uploaded as multipart data. Several attachments use several Bot API calls and can be
partially delivered when a later call fails.

## Agent integration

```ts
import { createChannelAgent } from "@anvia/channel-agent";

const service = createChannelAgent({ channel, agent });
await service.start();
```

Use the default polling mode for the simplest executable. For a web service, construct the same
channel-agent service with webhook options, call `service.start()` during application startup, and
forward requests to `channel.receiveWebhook()`.

## Low-level API path

Use the validated client when an application needs Bot API operations without the `Channel`
abstraction:

```ts
import { createTelegramBotApiClient, TelegramApiError } from "@anvia/telegram";

const api = createTelegramBotApiClient({ token: process.env.TELEGRAM_BOT_TOKEN! });

try {
  const bot = await api.getMe();
  console.log(bot.username);
} catch (error) {
  if (error instanceof TelegramApiError) {
    console.error(error.method, error.errorCode, error.retryAfterSeconds);
  }
}
```

Use `parseTelegramUpdate()` at an untrusted HTTP boundary, then
`normalizeTelegramUpdate(parsed, bot)` when integrating a custom receive transport. Do not normalize
raw unknown JSON without parsing it first.

## Shutdown

```ts
await channel.stop();
```

Polling shutdown aborts `getUpdates`; webhook shutdown rejects new deliveries and waits for active
deliveries. Stop the channel-agent service instead when it owns the adapter.
