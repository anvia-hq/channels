# `@anvia/channel` guide

`@anvia/channel` is the platform-neutral foundation. Use it when application code must work with
more than one adapter, when a worker sends proactive messages, or when you are implementing a new
adapter. It has no dependency on `@anvia/core` or a platform SDK.

## Which utility should I use?

| Task                                   | Utility                                  |
| -------------------------------------- | ---------------------------------------- |
| Describe a destination                 | `ChannelAddress`                         |
| Describe portable output               | `ChannelMessage`                         |
| Receive normalized platform input      | `ChannelEvent` and `ChannelEventHandler` |
| Send potentially long output           | `sendChannelMessage()`                   |
| Send one already-bounded message       | `channel.send()`                         |
| Split a complete portable message      | `splitChannelMessage()`                  |
| Split raw text only                    | `splitChannelText()`                     |
| Validate portable buttons              | `validateChannelActions()`               |
| Validate portable outbound files       | `validateChannelAttachments()`           |
| Check whether an action ID is portable | `isChannelActionId()`                    |
| Implement a new adapter                | `Channel<RawEvent>`                      |

For normal Discord, Slack, or Telegram applications, create the channel with the platform factory
and use only the shared types plus `sendChannelMessage()` from this package.

## Addresses

A `ChannelAddress` identifies where output should go:

```ts
import type { ChannelAddress } from "@anvia/channel";

const address: ChannelAddress = {
  platform: "discord",
  accountId: "123456789012345678",
  conversationId: "234567890123456789",
  threadId: "345678901234567890",
};
```

- `platform` must match the adapter.
- `accountId` distinguishes two bot/application accounts on the same platform and is optional for
  proactive delivery.
- `conversationId` is the channel, chat, or direct-message conversation.
- `threadId` is the platform thread/topic identifier when present.

When replying to an incoming event, copy these fields from `event.platform`, `event.accountId`, and
`event.conversation` instead of reconstructing platform IDs.

## Send a portable message

Use `sendChannelMessage()` at application boundaries. The adapter decides its maximum text length,
and the helper sends the resulting parts sequentially:

```ts
import { sendChannelMessage } from "@anvia/channel";

const messages = await sendChannelMessage({
  channel,
  address,
  message: {
    text: report,
    replyToMessageId: sourceMessageId,
    actions: [
      { id: "report:acknowledge", label: "Acknowledge", style: "primary" },
      { id: "report:dismiss", label: "Dismiss", style: "danger" },
    ],
    attachments: [
      {
        type: "file",
        mediaType: "text/csv",
        filename: "report.csv",
        source: { type: "data", data: csvBuffer.toString("base64") },
      },
    ],
  },
});
```

Actions and attachments appear on the final split part. Reply metadata remains on every part. A
media-only message uses `text: ""` and at least one attachment.

If a later part fails to send, `sendChannelMessage()` throws `PartialDeliveryError` carrying the
`sent` prefix, the `failedPart`, and its `failedIndex` so callers can clean up or resume without
resending delivered parts.

Use HTTPS URLs only for URL-backed attachments:

```ts
const message = {
  text: "Dashboard snapshot",
  attachments: [
    {
      type: "image" as const,
      mediaType: "image/png",
      filename: "dashboard.png",
      source: { type: "url" as const, url: "https://cdn.example.com/dashboard.png" },
    },
  ],
};
```

Slack and Discord download URL-backed files in the application process. Pass a restricted `fetch`
implementation to those adapters when a URL can be selected by a user or model. Enforce an origin
allowlist and block private-network destinations.

## Handle every event type

`ChannelEvent` is a discriminated union. Narrow `event.type` before reading event-specific fields:

```ts
import type { ChannelEvent } from "@anvia/channel";

function inspect(event: ChannelEvent): void {
  switch (event.type) {
    case "message":
      console.log(event.text, event.attachments, event.replyTo);
      break;
    case "action":
      console.log(event.messageId, event.actionId);
      break;
    case "message-edited":
      console.log(event.messageId, event.text);
      break;
    case "message-deleted":
      console.log(event.messageId);
      break;
    case "reaction":
      console.log(event.messageId, event.reaction, event.removed);
      break;
  }
}
```

Platform adapters runtime-validate external payloads before producing these events. The original
validated platform value remains available as `event.raw`.

## Use optional channel operations safely

Inspect `channel.capabilities` before presenting a feature in generic code:

```ts
if (channel.capabilities?.typing === true) {
  await channel.showTyping?.(address);
}

if (channel.capabilities?.reactions === true && channel.react !== undefined) {
  await channel.react(sentMessage, "👍");
}

if (channel.capabilities?.delete === true && channel.delete !== undefined) {
  await channel.delete(sentMessage);
}
```

The standard adapters advertise their exact support. A custom text-only adapter may omit
`capabilities` entirely.

## Build a custom adapter

Use `Channel<RawEvent>` and keep every platform SDK type inside the adapter package:

```ts
import { splitChannelMessage } from "@anvia/channel";
import type { Channel, ChannelAddress, ChannelEventHandler, ChannelMessage } from "@anvia/channel";

type AcmeEvent = Readonly<{ id: string; body: unknown }>;

export class AcmeChannel implements Channel<AcmeEvent> {
  readonly platform = "acme";
  readonly capabilities = { actions: false } as const;

  splitMessage(message: ChannelMessage): readonly ChannelMessage[] {
    return splitChannelMessage({ message, maximumLength: 2_000 });
  }

  async start(handler: ChannelEventHandler<AcmeEvent>): Promise<void> {
    // Connect the Acme SDK, validate its payload, normalize it, then await handler(event).
  }

  async stop(): Promise<void> {
    // Detach listeners, close the SDK, and drain in-flight deliveries.
  }

  async send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage> {
    // Validate the address and message before calling the platform.
    return { id: "platform-message-id", address };
  }

  // Text-only adapters omit edit; editable ones advertise
  // capabilities.messageEdits and implement it.
}
```

Implement `loadAttachment()` when normalized incoming messages expose attachment metadata. Never
put authenticated download URLs or platform credentials into a normalized event.

`edit()` is optional: omit it for text-only adapters and gate calls on
`capabilities.messageEdits === true && channel.edit !== undefined`. When `edit` is omitted, a
channel-agent bridge automatically buffers streamed responses into a single send.

## Portable limits

- At most 5 actions per message.
- At most 80 characters per action label.
- At most 64 UTF-8 bytes per action ID.
- At most 10 outbound attachments per logical message.
- Attachment URLs must use HTTPS.
- Attachment data must be valid base64.

Use the exported `MAX_CHANNEL_*` constants when an application UI needs to enforce the same limits.
