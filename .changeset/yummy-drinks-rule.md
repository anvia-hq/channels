---
"@anvia/channel-agent": patch
---

Finish delivering successful interaction resume outcomes during shutdown so completed results are not discarded and pending prompts match what users received.
Keep the channel open until queued outcomes and placeholder cleanup finish, then stop the adapter.
