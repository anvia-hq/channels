---
"@anvia/slack": patch
---

Fix `SlackChannel.splitMessage` to keep `replyToMessageId` on every split part, so long replies keep all continuations in the reply thread instead of dropping them to the channel top level.
