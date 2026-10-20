---
"@anvia/telegram": patch
---

Skip Telegram updates whose handler keeps failing. After `maxHandlerAttempts` failures (default 10, roughly 2.5 minutes of exponentially backed-off polling retries) the update is reported via `onError` with `poisoned: true` and skipped so one bad update no longer stalls delivery. Set `onError` to observe drops; without it, discards are silent.
