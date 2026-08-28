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
- `@anvia/telegram`: Telegram long-polling transport and messaging adapter.

The first adapters are implemented and awaiting live credential-based verification before
publishing.

Inbound images and files are normalized across Discord, Slack, and Telegram. `@anvia/channel-agent`
loads them through the originating adapter and constructs an Anvia multimodal prompt automatically.

Slack, Discord, and Telegram also render platform-neutral message actions as native buttons. Agent
tool approvals and single-choice questions use those controls automatically while retaining a text
reply fallback for custom adapters without action support.

Outbound images, audio, video, and files accept either HTTPS URLs or base64 data. Reply context,
message edits, deletions, reactions, and typing indicators are normalized or exposed when the
selected platform supports them. Inspect `channel.capabilities` before calling an optional
operation from a custom integration.

## Proactive delivery

Monitors, workers, and application services can send without starting an agent bridge. Use the
multi-part helper so long output is split according to the selected platform:

```ts
import { sendChannelMessage } from "@anvia/channel";
import { telegram } from "@anvia/telegram";

const channel = telegram({ token: process.env.TELEGRAM_BOT_TOKEN! });
await sendChannelMessage(
  channel,
  { platform: "telegram", conversationId: "-1001234567890" },
  { text: monitoringReport },
);
```

`Channel.send()` remains the low-level operation for one platform-sized logical delivery. An
adapter may need multiple platform API calls to upload several attachments.

## Development

This repository requires Node.js 24 or later and pnpm 11.

```sh
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

Run `pnpm verify:release` before publishing. Credential-backed verification remains an explicit
release gate; see [`docs/live-verification.md`](./docs/live-verification.md).

For package selection and complete application flows, start with the
[`docs` guide](./docs/README.md).

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
