# `@anvia/slack` guide

`@anvia/slack` combines Socket Mode for inbound events with Slack Web API calls for outbound
messages. Start with `slack()` unless the host application already owns a Slack transport.

## Which utility should I use?

| Task                                            | Utility                                                    |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Normal Socket Mode application or agent         | `slack()`                                                  |
| Inject an existing transport                    | `new SlackChannel({ transport })`                          |
| Use the built-in Socket Mode transport directly | `SlackSocketTransport`                                     |
| Implement a replacement transport               | `SlackTransport` interface                                 |
| Parse raw Socket Mode payloads                  | `parseSlackSocketEvent()`, `parseSlackSocketInteraction()` |
| Normalize validated Slack values                | `normalizeSlackEvent()`                                    |
| Normalize only messages or actions              | `normalizeSlackMessage()`, `normalizeSlackAction()`        |
| Validate Slack IDs or message timestamps        | `validateSlackId()`, `validateSlackTimestamp()`            |

Normal applications need `slack()` and `sendChannelMessage()`. Parsing helpers are for custom
transports and tests.

## Configure the Slack app

1. Create a Slack app and enable **Socket Mode**.
2. Create an app-level token with `connections:write`; pass it as `appToken`.
3. Install the app with a bot token containing `chat:write`.
4. Add `app_mentions:read` plus the history scopes matching received conversations. A minimal
   direct-message setup uses `im:history`; broader subscriptions use `channels:history`,
   `groups:history`, or `mpim:history` as applicable.
5. Add `files:read` for incoming attachment downloads, `files:write` for outbound attachments, and
   `reactions:write` for `channel.react()`. To receive reaction lifecycle events, also add
   `reactions:read` and subscribe to `reaction_added` and `reaction_removed`.
6. Subscribe to `app_mention` and `message.im` for mention-driven channels and direct messages.
7. Enable **Interactivity & Shortcuts** for portable action buttons.
8. Reinstall the app after changing scopes or subscriptions, and invite it to channels where it
   should receive mentions.

Request only the scopes used by the application. `chat:write.public` is needed only when the app
must proactively post to public channels it has not joined. Refer to Slack's
[OAuth scope catalog](https://api.slack.com/scopes) and
[Events API guide](https://api.slack.com/apis/connections/events-api) when selecting additional
features.

## Create the adapter

```ts
import { slack } from "@anvia/slack";

const channel = slack({
  appToken: process.env.SLACK_APP_TOKEN!,
  botToken: process.env.SLACK_BOT_TOKEN!,
  maximumAttachmentBytes: 20 * 1024 * 1024,
  onError(error, context) {
    console.error("slack", context.operation, error);
  },
});
```

The app token should begin with `xapp-`; the installed bot token should begin with `xoxb-`. Never
log either token.

## Send proactively

Outbound Web API calls do not require Socket Mode to be started:

```ts
import { sendChannelMessage } from "@anvia/channel";

await sendChannelMessage(
  channel,
  { platform: "slack", conversationId: process.env.SLACK_CHANNEL_ID! },
  {
    text: "The import needs review.",
    attachments: [
      {
        type: "file",
        mediaType: "text/csv",
        filename: "invalid-rows.csv",
        source: { type: "data", data: csvBuffer.toString("base64") },
      },
    ],
  },
);
```

Text is posted first and files are uploaded sequentially with `files.uploadV2`. A multi-file
delivery may be partially visible if a later upload fails; use idempotent application retries.

## Receive normalized events

```ts
await channel.start(async (event) => {
  if (event.type === "message") {
    console.log(event.text, event.attachments, event.conversation.threadId);
  }
  if (event.type === "action") {
    console.log(event.actionId);
  }
});
```

Socket envelopes and interactive payloads are acknowledged before handler execution. Duplicate
deliveries are suppressed with bounded in-memory keys. Bot-authored events are filtered before the
application handler runs.

## Threads and replies

Slack thread timestamps map directly to `ChannelAddress.threadId`. `replyToMessageId` takes
precedence when explicitly provided; otherwise sends to the address thread:

```ts
const address: { platform: string; conversationId: string; threadId?: string } = {
  platform: "slack",
  conversationId: event.conversation.id,
};
if (event.conversation.threadId !== undefined) {
  address.threadId = event.conversation.threadId;
}

await channel.send(address, { text: "Following up in this thread." });
```

Message IDs and thread IDs are Slack timestamps such as `1712345678.123456`, not arbitrary UUIDs.

## Attachments and generated text

Incoming private file URLs are retained only inside the validated Slack transport value.
`channel.loadAttachment()` performs an authenticated, size-capped download and returns base64 data;
the token-bearing URL is never placed in the agent prompt.

The adapter escapes Slack control mentions such as `<@U123>` and `<!channel>` in outbound text so
model-generated output does not unexpectedly notify users or channels.

Slack has no general bot typing-indicator API, so `channel.capabilities.typing` is absent. Use the
channel-agent placeholder if the user needs progress feedback.

## Agent integration

```ts
import { createChannelAgent } from "@anvia/channel-agent";

const service = createChannelAgent({
  channel,
  agent,
  streaming: { placeholder: "Thinking…" },
});
await service.start();
```

The default filter responds to direct messages and channel mentions/replies. Broader Slack event
subscriptions do not automatically broaden this filter; customize `shouldHandle` when required.

## Low-level extension path

Inject `SlackTransport` when another layer owns Socket Mode or when tests need a fake transport:

```ts
import { SlackChannel } from "@anvia/slack";

const channel = new SlackChannel({ transport: existingSlackTransport });
```

The transport must parse and validate external payloads before emitting `SlackSocketEvent`,
acknowledge Slack envelopes promptly, and drain active handlers during shutdown.

## Shutdown

```ts
await channel.stop();
```

Stopping detaches listeners, disconnects Socket Mode, and waits for in-flight deliveries. Stop the
channel-agent service instead when it owns the channel.
