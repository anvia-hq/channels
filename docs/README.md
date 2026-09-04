# Anvia Channels documentation

Use this documentation when deciding which package and utility belongs at each point in a channel
application. The package READMEs are concise references; these guides follow the complete path from
platform setup through delivery and shutdown.

## Start here

- [End-to-end guide](./end-to-end.md): choose packages and assemble a complete bot, agent, or
  proactive sender.
- [`@anvia/channel`](./channel.md): shared contracts, message splitting, validation, and custom
  adapters.
- [`@anvia/channel-agent`](./channel-agent.md): connect any adapter to an Anvia agent.
- [`@anvia/discord`](./discord.md): Discord Gateway input and REST delivery.
- [`@anvia/slack`](./slack.md): Slack Socket Mode input and Web API delivery.
- [`@anvia/telegram`](./telegram.md): Telegram polling, webhook input, and Bot API delivery.
- [Live verification](./live-verification.md): credential-backed checks required before publishing.

## Utility chooser

| You need to…                                         | Use                                                            | Package                |
| ---------------------------------------------------- | -------------------------------------------------------------- | ---------------------- |
| Represent a platform-independent address or message  | `ChannelAddress`, `ChannelMessage`                             | `@anvia/channel`       |
| Send output that may exceed a platform text limit    | `sendChannelMessage()`                                         | `@anvia/channel`       |
| Split text in a custom adapter                       | `splitChannelMessage()` or `splitChannelText()`                | `@anvia/channel`       |
| Validate portable buttons or files at runtime        | `validateChannelActions()`, `validateChannelAttachments()`     | `@anvia/channel`       |
| Create a Discord adapter                             | `discord()`                                                    | `@anvia/discord`       |
| Create a Slack adapter                               | `slack()`                                                      | `@anvia/slack`         |
| Create a Telegram adapter                            | `telegram()`                                                   | `@anvia/telegram`      |
| Connect an adapter to an existing Anvia agent        | `createChannelAgent()`                                         | `@anvia/channel-agent` |
| Create and immediately start that bridge             | `serveChannelAgent()`                                          | `@anvia/channel-agent` |
| Preserve incoming attachments in a custom prompt     | `channelMessagePrompt()`                                       | `@anvia/channel-agent` |
| Choose shared or sender-isolated conversation memory | `channelConversationSession`, `channelConversationUserSession` | `@anvia/channel-agent` |
| Keep approvals/questions until restart only          | `MemoryChannelAgentInteractionStore`                           | `@anvia/channel-agent` |
| Keep approvals/questions across restarts             | `SqliteChannelAgentInteractionStore`                           | `@anvia/channel-agent` |
| Integrate a custom Discord transport                 | `DiscordGateway`, `DiscordChannel`                             | `@anvia/discord`       |
| Integrate a custom Slack transport                   | `SlackTransport`, `SlackChannel`                               | `@anvia/slack`         |
| Call Telegram Bot API through the validated client   | `createTelegramBotApiClient()`                                 | `@anvia/telegram`      |
| Parse raw platform payloads yourself                 | platform `parse…` and `normalize…` helpers                     | platform package       |

## The normal application path

Most applications need only three layers:

```text
Platform adapter
  discord() | slack() | telegram()
        ↓ normalized ChannelEvent
Channel-agent bridge
  createChannelAgent({ channel, agent })
        ↓ Agent prompt and outcome
Anvia agent
  @anvia/core Agent
```

Use the lower-level parser, normalizer, gateway, and transport exports only when replacing the
built-in platform transport or embedding it into an existing framework.

## Two valid application shapes

### Proactive sender

Use an adapter plus `sendChannelMessage()`. You do not need to call `start()` when the process only
sends scheduled alerts or worker output.

```ts
import { sendChannelMessage } from "@anvia/channel";
import { telegram } from "@anvia/telegram";

const channel = telegram({ token: process.env.TELEGRAM_BOT_TOKEN! });

await sendChannelMessage({
  channel,
  address: { platform: "telegram", conversationId: "-1001234567890" },
  message: { text: "The nightly import completed." },
});
```

### Receiving bot or agent

Start either the adapter directly with a `ChannelEvent` handler, or start a channel-agent service.
Always stop the same owner during graceful shutdown:

```ts
const service = createChannelAgent({ channel, agent });

await service.start();
process.once("SIGTERM", () => {
  void service.stop();
});
```

Do not start both the adapter and a channel-agent service over that adapter. The service owns the
adapter lifecycle.

## Package status

The package names in these guides are the intended installation names. This repository currently
keeps them private until the live-platform matrix passes. Within this pnpm workspace, examples use
the same names through workspace dependencies.
