---
"@anvia/discord": patch
"@anvia/telegram": patch
---

Keep Discord deferred replies scoped to their originating command through asynchronous and queued handlers, preserve files in deferred replies, clean up unanswered deferrals, and propagate reply failures without duplicate fallback posts. Preserve Telegram handler retries when malformed or out-of-order updates share a polling batch.
