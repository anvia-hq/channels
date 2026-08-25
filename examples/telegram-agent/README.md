# Telegram agent example

This example runs one Anvia agent behind a Telegram bot. Incoming conversations are mapped to
stable Anvia sessions, responses stream into a placeholder message, and conversation history is
stored in a local SQLite database.

## Prerequisites

- Node.js 24 or later and pnpm 11.
- A Telegram bot token created with [BotFather](https://t.me/BotFather).
- An OpenAI API key with access to the configured model.

## Run it

From the repository root:

```sh
cp examples/telegram-agent/.env.example examples/telegram-agent/.env
```

Fill in `TELEGRAM_BOT_TOKEN` and `OPENAI_API_KEY`, then start the bot:

```sh
pnpm example:telegram
```

The default model is `gpt-5.6`. Set `OPENAI_MODEL` to another model supported by your account. You
can also set `OPENAI_BASE_URL` for a compatible endpoint and `ANVIA_MEMORY_PATH` to relocate the
SQLite database.

This transport uses Telegram long polling. Remove any webhook configured for the bot before
running it, because Telegram does not deliver polling updates while a webhook is active.

## Verify the live flow

1. Open a direct chat with the bot and send a message.
2. Confirm that `Thinking…` appears and is edited into the final answer.
3. Send a follow-up that depends on the first message to confirm conversation memory.
4. Press Ctrl+C and start the example again, then verify that the conversation context persists.

The `.env` file and SQLite data are ignored by Git. Never commit either credential.
