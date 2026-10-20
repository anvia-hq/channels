---
"@anvia/telegram": patch
---

Require commands in groups and supergroups to target this bot by default, matching usernames case-insensitively. Keep bare commands in private chats and add `allowBareGroupCommands` to opt into bare group commands. Drop rejected commands instead of forwarding them as ordinary messages so they cannot trigger agent runs through message filters.
