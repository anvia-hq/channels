# Slack agent example

This example runs one Anvia agent behind a Slack app using Socket Mode. Direct messages and
channel mentions are mapped to stable Anvia sessions. Responses stream into a placeholder message,
and conversation history is stored in a local SQLite database.

## Configure Slack

1. Create an app at [Slack API: Your Apps](https://api.slack.com/apps).
2. Enable **Socket Mode**.
3. Create an app-level token with `connections:write`; this is `SLACK_APP_TOKEN` (`xapp-…`).
4. Under OAuth & Permissions, add `app_mentions:read`, `chat:write`, and `im:history` bot scopes.
5. Under Event Subscriptions, subscribe to `app_mention` and `message.im` bot events.
6. Install or reinstall the app, then copy its bot token into `SLACK_BOT_TOKEN` (`xoxb-…`).
7. Invite the app into each channel where it should answer mentions.

Socket Mode replaces the public Events API request URL for this local example.

## Run it

From the repository root:

```sh
cp examples/slack-agent/.env.example examples/slack-agent/.env
```

Fill in the three required credentials, then start the app:

```sh
pnpm example:slack
```

The default model is `gpt-5.6`. Set `OPENAI_MODEL` to another model supported by your account. You
can also set `OPENAI_BASE_URL` for a compatible endpoint and `ANVIA_MEMORY_PATH` to relocate the
SQLite database.

## Verify the live flow

1. Send the app a direct message and confirm `Thinking…` becomes the final answer.
2. Mention the app in an invited channel and confirm it responds.
3. Mention it inside an existing Slack thread and confirm the response remains in that thread.
4. Send a contextual follow-up in the direct message, then restart and verify memory persists.
5. Send a normal unmentioned channel message and confirm the agent does not respond.

With the minimal event subscriptions above, channel messages must explicitly mention the app. The
`.env` file and SQLite data are ignored by Git. Never commit either token.

## Example structure

- `config.ts` validates environment configuration.
- `models.ts` creates the OpenAI completion model.
- `agents.ts` configures the Anvia agent and its memory policy.
- `channels.ts` configures the Slack adapter.
- `application.ts` composes the channel agent and owns resource cleanup.
- `types.ts` defines the example's configuration and lifecycle boundaries.
- `index.ts` only handles process startup and shutdown signals.
