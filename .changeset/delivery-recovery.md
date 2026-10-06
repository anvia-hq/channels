---
"@anvia/discord": patch
"@anvia/telegram": patch
---

Keep Discord deferred replies scoped to their originating command through asynchronous and queued handlers, preserve files in deferred replies, clean up unanswered deferrals, and propagate reply failures without duplicate fallback posts. Wait for an in-flight initial reply before handler cleanup and shutdown, including when a concurrent send fails. Preserve Telegram handler retries when malformed or out-of-order updates share a polling batch.
