# `@anvia/channel`

Platform-neutral contracts and delivery helpers for communication channels.

Incoming message events include normalized attachment metadata for images, audio, video, and
general files. An adapter that emits attachments implements
`Channel.loadAttachment(event, attachment, signal)` to resolve one to either an HTTPS URL or base64
data. Adapters own authenticated downloads, so platform credentials never need to appear in shared
events or agent prompts. Text-only adapters can omit `loadAttachment`.

`Channel.send()` sends one platform-sized message. Use `sendChannelMessage()` for application or
worker output that may exceed a platform limit. The channel's `splitMessage()` implementation owns
the platform-specific boundary, while the helper preserves part ordering.

```ts
import { sendChannelMessage } from "@anvia/channel";

const sent = await sendChannelMessage(channel, address, {
  text: report,
});
```

## Message actions

Adapters may advertise `channel.capabilities.actions` and accept portable actions on outgoing
messages. Selecting one produces a `ChannelActionEvent`; action IDs are opaque application values
and must not contain credentials or serialized continuations.

```ts
await channel.send(address, {
  text: "Deploy this release?",
  actions: [
    { id: "deploy:approve", label: "Approve", style: "primary" },
    { id: "deploy:deny", label: "Deny", style: "danger" },
  ],
});
```

The portable limits are five actions per message, 80 characters per label, and 64 UTF-8 bytes per
action ID. `splitChannelMessage()` places actions only on the final part of a long message. Custom
text-only adapters can omit `capabilities`; callers should then use a textual fallback.

Custom adapters implement `splitMessage(message)` in addition to lifecycle, send, and edit, plus
`loadAttachment` if they emit attachment metadata. The split method must return at least one
non-empty message and preserve the original content when its text parts are concatenated.
`splitChannelMessage(message, maximumLength)` provides a whitespace-aware, surrogate-safe default
that also preserves actions. `splitChannelText(text, maximumLength)` remains available for raw text.
