---
"@anvia/telegram": patch
---

Make callback query acknowledgement best-effort in polling and webhook delivery. Report acknowledgement errors through onError without blocking update handlers, subsequent updates, or retries after handler failures.
