# Anvia Channels

Strict TypeScript adapters that connect Discord, Slack, and Telegram to Anvia agents or ordinary
application code. The workspace also supports proactive delivery from workers, monitors, and
scheduled jobs without starting an agent.

> The five libraries are currently private workspace packages while live-platform verification is
> completed. They are not published to npm yet.

## Start here

- [Documentation and utility chooser](./docs/README.md)
- [Build an application end to end](./docs/end-to-end.md)
- [Live-platform verification checklist](./docs/live-verification.md)
- Runnable examples: [Discord](./examples/discord-agent), [Slack](./examples/slack-agent), and
  [Telegram](./examples/telegram-agent)

## Packages

This repository contains five libraries:

| Package                                            | Use it for                                                                     | Start with             |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------- |
| [`@anvia/channel`](./packages/channel)             | Platform-neutral addresses, events, messages, validation, and delivery helpers | `sendChannelMessage()` |
| [`@anvia/channel-agent`](./packages/channel-agent) | Running an Anvia agent behind any channel adapter                              | `createChannelAgent()` |
| [`@anvia/discord`](./packages/discord)             | Discord Gateway input and REST delivery                                        | `discord()`            |
| [`@anvia/slack`](./packages/slack)                 | Slack Socket Mode input and Web API delivery                                   | `slack()`              |
| [`@anvia/telegram`](./packages/telegram)           | Telegram polling, webhook input, and Bot API delivery                          | `telegram()`           |

The workspace also contains three private example packages under `examples/*`. They demonstrate
complete Discord, Slack, and Telegram agents with OpenAI models and persistent SQLite conversation
memory.

## Run an agent on a channel

Create a platform adapter, pass it and an existing Anvia agent to `createChannelAgent()`, and start
the returned service:

```ts
import { createChannelAgent } from "@anvia/channel-agent";
import { telegram } from "@anvia/telegram";

const channel = telegram({ token: process.env.TELEGRAM_BOT_TOKEN! });
const service = createChannelAgent({
  channel,
  agent,
  streaming: { placeholder: "Thinking…" },
});

await service.start();

process.once("SIGTERM", () => {
  void service.stop();
});
```

The bridge handles default message filtering, stable conversation sessions, multimodal prompts,
streaming edits, long-message splitting, native actions, and paused approval or question flows.
Use [the end-to-end guide](./docs/end-to-end.md) for agent construction, durable memory,
interaction storage, attachment policy, and graceful shutdown.

## Send proactively

An alerting or worker process only needs a platform adapter and `sendChannelMessage()`. Receiving
does not need to be started:

```ts
import { sendChannelMessage } from "@anvia/channel";
import { discord } from "@anvia/discord";

const channel = discord({ token: process.env.DISCORD_BOT_TOKEN! });

await sendChannelMessage(
  channel,
  { platform: "discord", conversationId: process.env.DISCORD_CHANNEL_ID! },
  {
    text: monitoringReport,
    actions: [{ id: "incident:ack", label: "Acknowledge", style: "primary" }],
  },
);
```

Use `sendChannelMessage()` at application boundaries because it splits long text according to the
selected platform. Use `channel.send()` only for one already-bounded logical message.

## Platform capabilities

| Platform | Receive transport       | Files | Native actions    | Replies and threads | Typing |
| -------- | ----------------------- | ----- | ----------------- | ------------------- | ------ |
| Discord  | Gateway                 | Yes   | Buttons           | Yes                 | Yes    |
| Slack    | Socket Mode             | Yes   | Block Kit buttons | Yes                 | No     |
| Telegram | Long polling or webhook | Yes   | Inline keyboard   | Yes                 | Yes    |

All three adapters expose message edits, deletion, and reactions. Incoming external payloads are
validated at runtime and normalized into `ChannelEvent` values. Optional operations are advertised
through `channel.capabilities`.

See the platform guides for credentials, permissions, scopes, subscriptions, attachment behavior,
and transport extension points:

- [Discord guide](./docs/discord.md)
- [Slack guide](./docs/slack.md)
- [Telegram guide](./docs/telegram.md)

## Run an example

Install workspace dependencies first:

```sh
pnpm install
```

Then configure and start one example:

| Platform | Configuration                                                                                                         | Command                 |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Discord  | Copy `examples/discord-agent/.env.example` to `.env` and set `DISCORD_BOT_TOKEN` and `OPENAI_API_KEY`                 | `pnpm example:discord`  |
| Slack    | Copy `examples/slack-agent/.env.example` to `.env` and set `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, and `OPENAI_API_KEY` | `pnpm example:slack`    |
| Telegram | Copy `examples/telegram-agent/.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN` and `OPENAI_API_KEY`               | `pnpm example:telegram` |

Never commit an example `.env` file, bot token, app token, API key, or real platform payload.

## Development

Requirements: Node.js 24 or later and pnpm 11.

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

Run the complete offline release gate with:

```sh
pnpm verify:release
```

Packages remain private until the credential-backed scenarios in
[live verification](./docs/live-verification.md) pass. The offline test suite does not require live
platform credentials or network access.
