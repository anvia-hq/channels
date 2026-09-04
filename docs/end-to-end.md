# Build an Anvia channel application end to end

This guide starts with the product behavior you want, selects the minimum utilities, and finishes
with startup, shutdown, persistence, and verification.

## 1. Choose the application shape

| Desired behavior                        | Required packages                                  | Main utility                                                |
| --------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| Send alerts only                        | `@anvia/channel` plus one adapter                  | `sendChannelMessage()`                                      |
| Receive events and run application code | one adapter                                        | `channel.start(handler)`                                    |
| Receive events and run an Anvia agent   | one adapter, `@anvia/channel-agent`, `@anvia/core` | `createChannelAgent()`                                      |
| Build a reusable custom adapter         | `@anvia/channel`                                   | `Channel` interface                                         |
| Use your own platform transport         | adapter package                                    | `DiscordGateway`, `SlackTransport`, or Telegram API helpers |

Do not add `@anvia/channel-agent` to a sender-only worker. Do not use raw platform parsers when the
standard adapter already owns the connection.

## 2. Choose a platform factory

```ts
import { discord } from "@anvia/discord";
import { slack } from "@anvia/slack";
import { telegram } from "@anvia/telegram";

const discordChannel = discord({ token: process.env.DISCORD_BOT_TOKEN! });
const slackChannel = slack({
  appToken: process.env.SLACK_APP_TOKEN!,
  botToken: process.env.SLACK_BOT_TOKEN!,
});
const telegramChannel = telegram({ token: process.env.TELEGRAM_BOT_TOKEN! });
```

Choose exactly one of these objects for each channel-agent service. An application may run several
services when it intentionally exposes the same or different agents on several platforms.

## 3A. Build a proactive sender

Use `sendChannelMessage()` for reports, alerts, and generated output. It delegates text limits to
the adapter, sends every part in order, and keeps actions and attachments on the final part.

```ts
import { sendChannelMessage } from "@anvia/channel";
import { discord } from "@anvia/discord";

const channel = discord({ token: process.env.DISCORD_BOT_TOKEN! });

const sent = await sendChannelMessage({
  channel,
  address: { platform: "discord", conversationId: process.env.DISCORD_CHANNEL_ID! },
  message: {
    text: "Build 184 passed.",
    attachments: [
      {
        type: "file",
        mediaType: "application/json",
        filename: "summary.json",
        source: { type: "data", data: Buffer.from('{"passed":true}').toString("base64") },
      },
    ],
    actions: [{ id: "build:184:details", label: "Show details", style: "primary" }],
  },
});

console.log(sent.map((message) => message.id));
```

Use `channel.send()` only when the input is already one platform-sized logical message. Several
attachments may require several platform calls, so record application-level delivery IDs and make
retries idempotent.

## 3B. Build a direct event handler

Start the adapter when you want normalized events without an agent:

```ts
import { sendChannelMessage } from "@anvia/channel";
import { telegram } from "@anvia/telegram";

const channel = telegram({ token: process.env.TELEGRAM_BOT_TOKEN! });

await channel.start(async (event) => {
  if (event.type !== "message") return;

  const address: {
    platform: string;
    accountId?: string;
    conversationId: string;
    threadId?: string;
  } = { platform: event.platform, conversationId: event.conversation.id };
  if (event.accountId !== undefined) address.accountId = event.accountId;
  if (event.conversation.threadId !== undefined) {
    address.threadId = event.conversation.threadId;
  }

  await sendChannelMessage({
    channel,
    address,
    message: { text: `Received ${event.text.length} characters.` },
  });
});
```

Handle the discriminated `event.type` values you need: `message`, `action`, `message-edited`,
`message-deleted`, or `reaction`.

## 3C. Build an agent-backed bot

The platform factory owns platform behavior. `createChannelAgent()` owns filtering, prompt
creation, streaming, conversation serialization, interaction resumption, and the adapter lifecycle.

```ts
import { mkdir } from "node:fs/promises";
import { createChannelAgent, SqliteChannelAgentInteractionStore } from "@anvia/channel-agent";
import { Agent } from "@anvia/core";
import { OpenAIClient } from "@anvia/openai";
import { telegram } from "@anvia/telegram";

await mkdir("data", { recursive: true });

const openai = new OpenAIClient({ apiKey: process.env.OPENAI_API_KEY! });
const agent = new Agent({
  id: "support-agent",
  model: openai.completionModel({ modelId: "gpt-5.6", api: "responses" }),
  instructions: "Answer concisely and do not disclose secrets.",
});

const channel = telegram({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  onError(error, context) {
    console.error("telegram", context.operation, error);
  },
});
const interactions = new SqliteChannelAgentInteractionStore({
  database: "data/channel-interactions.sqlite",
});
const service = createChannelAgent({
  channel,
  agent,
  interactions: { store: interactions },
  streaming: { placeholder: "Thinking…", editIntervalMs: 750 },
  onError(error, context) {
    console.error("channel-agent", context.stage, error);
  },
});

await service.start();
```

`SqliteChannelAgentInteractionStore` persists paused approvals and questions. It is separate from
the agent's conversation-memory store. Configure agent memory through `@anvia/core` when history
must survive restarts.

## 4. Choose conversation scope

The default session scope isolates history by platform, bot account, conversation, thread, and
sender. Change only when the product needs a shared group history:

```ts
import { channelConversationSession, createChannelAgent } from "@anvia/channel-agent";

const service = createChannelAgent({
  channel,
  agent,
  createSession: channelConversationSession,
});
```

Use `channelConversationUserSession` when you want to state the default sender-isolated behavior
explicitly. A custom `createSession` may return `undefined` to run without memory for selected
events.

## 5. Choose attachment policy

Incoming attachment metadata is normalized by the adapter. `channelMessagePrompt()` loads the bytes
only when the agent bridge prepares a prompt. Default limits are 10 files, 20 MiB per file, 50 MiB
total, and two concurrent loads.

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

Set `multimodal: false` when the selected model or application must reject file input.

## 6. Shut down every owned resource

Stop the highest-level owner. A channel-agent service stops its adapter and drains queued
conversation work. Then close memory and interaction databases:

```ts
let shutdownPromise: Promise<void> | undefined;

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    try {
      await service.stop();
    } finally {
      interactions.close();
    }
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
```

If you started an adapter directly, call `channel.stop()` instead. A proactive-only process that
never called `start()` has no adapter receive loop to stop.

## 7. Verify before deployment

Run the offline gate from the workspace root:

```sh
pnpm verify:release
```

Then complete the credential-backed scenarios in [live verification](./live-verification.md). The
offline suite never calls live platform APIs.
