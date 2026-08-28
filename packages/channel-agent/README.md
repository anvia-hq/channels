# `@anvia/channel-agent`

Connect an Anvia agent to any `@anvia/channel` adapter.

```ts
import { createChannelAgent } from "@anvia/channel-agent";

const service = createChannelAgent({
  channel,
  agent,
  streaming: {
    placeholder: "Thinking…",
    editIntervalMs: 750,
  },
  onError(error, context) {
    // Send errors to your application logger or observability system.
  },
});

await service.start();

// During graceful application shutdown:
await service.stop();
```

By default, the service handles direct messages and group messages that mention or reply to the
bot. Runs within one conversation or thread are serialized, while unrelated conversations may run
concurrently. Long answers are split using the platform adapter's message boundary.

## Multimodal input

Images and other attached files are converted to Anvia multimodal user content automatically.
Image attachments become image parts; audio, video, PDFs, and other documents become file parts.
Text-only messages keep the original string prompt shape.

Loading is bounded by default to 10 attachments, 20 MiB per attachment, 50 MiB total, and two
concurrent loads. Adjust these application limits with `multimodal`, or set `multimodal: false` to
reject messages containing attachments before invoking the model:

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

Custom prompt builders receive the channel and abort signal as their second argument. Use the
exported helper when adding application-specific text while preserving attachments:

```ts
import { channelMessagePrompt, createChannelAgent } from "@anvia/channel-agent";

const service = createChannelAgent({
  channel,
  agent,
  async createPrompt(event, context) {
    const prompt = await channelMessagePrompt(context.channel, event, {
      signal: context.abortSignal,
    });
    // Return `prompt` directly, or transform its user content for your application.
    return prompt;
  },
});
```

Custom prompt builders own their attachment policy; pass the same limit options to
`channelMessagePrompt` when needed. URL-backed attachments must include their byte size. The
selected Anvia model/provider must support the received media type. Attachment loading errors
follow the normal `prepare` error path and do not invoke the model.

Agents without a memory store run without a session automatically. For memory-enabled agents, the
default scope is isolated by platform, bot account, conversation, thread, and sender. Use the
shared-conversation strategy when everyone in a group or channel should see the same history:

```ts
import { channelConversationSession, createChannelAgent } from "@anvia/channel-agent";

const service = createChannelAgent({
  channel,
  agent,
  createSession: channelConversationSession,
});
```

`channelConversationUserSession` is the explicit name for the default sender-isolated strategy.
Return `undefined` from a custom `createSession` to run a particular event without memory.

Streaming is enabled automatically when the agent model reports streaming support. Set
`streaming.enabled` explicitly to override detection. Set `streaming.placeholder` to `false` to
buffer the result and send only the final response.

## Questions and approvals

Anvia tool questions and approvals are rendered as channel messages and resumed from the same
sender's next handled reply. Group replies must still satisfy `shouldHandle` (a mention or reply to
the bot by default), so an unrelated group message cannot satisfy an interaction. Approval replies
accept `approve`, `deny`, `yes`, or `no`. The default approval prompt includes a bounded input
preview and redacts common credential fields. Applications should provide `interactions.render`
when tool-specific redaction or presentation is required. One question accepts a single reply;
multiple questions accept one answer per line. Choice labels and values are both recognized.

Pending continuations are held in a `MemoryChannelAgentInteractionStore` by default. Applications
that must survive a process restart should provide a durable `interactions.store`; continuations
must remain server-side and must not be sent to the platform. Rendering and response parsing are
customizable through `interactions.render` and `interactions.parseResponse`. Set
`interactions: false` to retain terminal, non-resumable rendering instead.
Continuation stores and resumed tools do not provide exactly-once execution; make externally
mutating tools idempotent when retries are possible.

```ts
const service = createChannelAgent({
  channel,
  agent,
  interactions: {
    store: durableInteractionStore,
    invalidResponseMessage: "Please answer using one of the listed choices.",
  },
});
```
