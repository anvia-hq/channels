# `@anvia/slack`

Slack Socket Mode and Web API adapter for Anvia Channels. Socket Mode receives Events API payloads
without a public HTTP endpoint, while the Web API sends and edits text messages.

## Usage

```ts
import { slack } from "@anvia/slack";

const channel = slack({
  appToken: process.env.SLACK_APP_TOKEN!,
  botToken: process.env.SLACK_BOT_TOKEN!,
  onError(error, context) {
    // Send errors to your application logger or observability system.
  },
});

await channel.start(async (event) => {
  await channel.send(
    {
      platform: "slack",
      accountId: event.accountId,
      conversationId: event.conversation.id,
      threadId: event.conversation.threadId,
    },
    { text: `Received: ${event.text}` },
  );
});

// During graceful application shutdown:
await channel.stop();
```

## Slack app configuration

Enable Socket Mode and create an app-level token with `connections:write`. Install the app with a
bot token containing these scopes:

- `app_mentions:read`
- `chat:write`
- `im:history`

Subscribe the bot to `app_mention` and `message.im`. This provides direct-message and explicit
mention behavior without subscribing the app to every workspace message. To receive broader
channel traffic, add the applicable `message.channels`, `message.groups`, or `message.mpim` events
and their history scopes.

Socket envelopes are acknowledged before application processing and duplicate deliveries are
suppressed by workspace, channel, and message timestamp. Slack threads map to `threadId`. Outbound
Slack control mentions such as `<@U123>` and `<!channel>` are escaped so generated text cannot
unexpectedly notify workspace members.
