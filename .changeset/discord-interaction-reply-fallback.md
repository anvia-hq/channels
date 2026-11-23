---
"@anvia/discord": patch
---

Deliver a channel post when a deferred command reply cannot be edited, and serialize concurrent
sends inside one command handler. An expired interaction token, a deleted placeholder message or a
Discord error used to discard the agent's whole answer and delete the deferred reply; the failure is
now reported through `onError` and the answer is posted to the channel instead.
