---
"@anvia/slack": patch
---

Record Socket Mode deduplication keys only after a message is fully handled. A handler failure no
longer marks the message as delivered, so a redelivery or the paired `app_mention`/`message`
envelope can still start the run instead of the message being lost for good.
