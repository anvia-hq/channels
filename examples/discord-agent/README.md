# Discord agent example

This example runs one Anvia agent behind a Discord bot. Direct messages and guild messages that
mention or reply to the bot are mapped to stable Anvia sessions. Responses stream into a
placeholder message, and conversation history is stored in a local SQLite database.

## Configure Discord

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. On the **Bot** page, generate a token and enable **Message Content Intent**.
3. On the **Installation** page, configure a Guild Install with the `bot` scope.
4. Grant **View Channels**, **Send Messages**, **Send Messages in Threads**, and **Read Message History**.
5. Use the installation link to add the bot to a test server.

Keep the bot token private. It grants access to the bot account.

## Run it

From the repository root:

```sh
cp examples/discord-agent/.env.example examples/discord-agent/.env
```

Fill in `DISCORD_BOT_TOKEN` and `OPENAI_API_KEY`, then start the bot:

```sh
pnpm example:discord
```

The default model is `gpt-5.6`. Set `OPENAI_MODEL` to another model supported by your account. You
can also set `OPENAI_BASE_URL` for a compatible endpoint and `ANVIA_MEMORY_PATH` to relocate the
SQLite database.

## Verify the live flow

1. Send the bot a direct message and confirm `Thinking…` becomes the final answer.
2. In a server channel, mention the bot and confirm it responds in that channel.
3. Mention the bot inside a thread and confirm the response stays in the thread.
4. Send a contextual follow-up, then restart the example and verify memory persists.
5. Send a normal unmentioned server message and confirm the agent does not respond.

The `.env` file and SQLite data are ignored by Git. Never commit either credential.

## Example structure

- `config.ts` validates environment configuration.
- `models.ts` creates the OpenAI completion model.
- `agents.ts` configures the Anvia agent and its memory policy.
- `channels.ts` configures the Discord adapter.
- `application.ts` composes the channel agent and owns resource cleanup.
- `types.ts` defines the example's configuration and lifecycle boundaries.
- `index.ts` only handles process startup and shutdown signals.
