---
"@anvia/channel-agent": patch
---

Fix attachment delivery with a streaming placeholder to delete the provisional placeholder when `sendChannelMessage` throws `PartialDeliveryError`, so a failed attachment send no longer leaves a dangling "Thinking…" message. The error still propagates to the existing delivery error reporting unchanged.
