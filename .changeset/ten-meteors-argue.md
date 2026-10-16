---
"@anvia/telegram": patch
---

Preserve replacement Telegram bot reactions when removing an earlier acknowledgement. Serialize reaction writes per message and clear only a matching reaction tracked by the channel instance; leave unknown reactions untouched and document Telegram's single-reaction and local-tracking limits.
