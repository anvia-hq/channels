---
"@anvia/channel": patch
---

Fix `splitChannelMessage` to attach `replyToMessageId` to the first split part only, so a long reply sends one reply followed by continuations instead of N separate replies. Actions and attachments remain on the last part.
