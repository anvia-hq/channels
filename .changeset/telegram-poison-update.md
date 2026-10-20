---
"@anvia/telegram": patch
---

Skip Telegram updates whose handler keeps failing. After `maxHandlerAttempts` failures (default 5) the update is reported via `onError` with `poisoned: true` and skipped so one bad update no longer stalls delivery.
