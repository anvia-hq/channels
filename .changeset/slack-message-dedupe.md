---
"@anvia/slack": patch
---

Deduplicate Slack message and app_mention callbacks by workspace, channel, and message timestamp to prevent double replies. Preserve event redelivery suppression and separate lifecycle, command, and interaction identities.
