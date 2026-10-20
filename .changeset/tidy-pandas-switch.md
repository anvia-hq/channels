---
"@anvia/channel-agent": patch
---

Bound channel agent runs with a configurable execution timeout (`runTimeoutMs`, default five minutes). A hung `generate`, `stream`, or `resume` call now aborts its run signal and reports through the existing `agent`-stage error path instead of wedging the conversation queue or `stop()`.
