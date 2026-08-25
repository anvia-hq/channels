# Anvia Channels

Channel adapters and agent integration for Slack, Discord, and Telegram.

Anvia Channels connects external communication platforms to Anvia agents and also supports
proactive outbound messages from monitors, workers, and application code.

## Status

This repository is in initial development. The Telegram package includes its first long-polling
transport, and the channel-agent package provides the initial Anvia execution and streaming bridge.
Packages remain private until the vertical slice has been exercised against a live bot.

## Workspace

- `@anvia/channel`: platform-neutral channel contracts.
- `@anvia/channel-agent`: integration between channel events and `@anvia/core` agents.
- `@anvia/discord`: Discord Gateway and messaging adapter.
- `@anvia/telegram`: Telegram long-polling transport and text messaging adapter.

Slack will be added after the Discord vertical slice has been exercised with a live bot.

## Development

This repository requires Node.js 24 or later and pnpm 11.

```sh
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

## Telegram agent example

The runnable example connects a Telegram bot to an Anvia agent backed by OpenAI and persistent
SQLite conversation memory. See [`examples/telegram-agent`](./examples/telegram-agent) for setup
and live verification instructions.

```sh
cp examples/telegram-agent/.env.example examples/telegram-agent/.env
# Fill in TELEGRAM_BOT_TOKEN and OPENAI_API_KEY.
pnpm example:telegram
```

The equivalent Discord example is available in [`examples/discord-agent`](./examples/discord-agent):

```sh
cp examples/discord-agent/.env.example examples/discord-agent/.env
# Fill in DISCORD_BOT_TOKEN and OPENAI_API_KEY.
pnpm example:discord
```
