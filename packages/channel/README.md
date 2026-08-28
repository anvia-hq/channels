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

Custom adapters implement `splitMessage(message)` in addition to lifecycle, send, and edit, plus
`loadAttachment` if they emit attachment metadata. The split method must return at least one
non-empty message and preserve the original content when its text parts are concatenated.
`splitChannelText(text, maximumLength)` provides a whitespace-aware, surrogate-safe default for
text platforms.
