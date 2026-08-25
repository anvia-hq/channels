# Anvia Channels

Channel adapters and agent integration for Slack, Discord, and Telegram.

Anvia Channels connects external communication platforms to Anvia agents and also supports
proactive outbound messages from monitors, workers, and application code.

## Status

This repository is in initial development. Telegram, Discord, and Slack adapters are implemented,
and the channel-agent package provides the initial Anvia execution and streaming bridge. Packages
remain private until each vertical slice has been exercised against a live bot.

## Workspace

- `@anvia/channel`: platform-neutral channel contracts.
- `@anvia/channel-agent`: integration between channel events and `@anvia/core` agents.
- `@anvia/discord`: Discord Gateway and messaging adapter.
- `@anvia/slack`: Slack Socket Mode and Web API adapter.
- `@anvia/telegram`: Telegram long-polling transport and text messaging adapter.

The first adapters are implemented and awaiting live credential-based verification before
publishing.

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

The Slack Socket Mode example is available in [`examples/slack-agent`](./examples/slack-agent):

```sh
cp examples/slack-agent/.env.example examples/slack-agent/.env
# Fill in SLACK_APP_TOKEN, SLACK_BOT_TOKEN, and OPENAI_API_KEY.
pnpm example:slack
```
