---
"@anvia/discord": patch
---

Acknowledge every incoming interaction. Unsupported interaction types (context menus, select
menus, modal submits) and interactions whose payload cannot be read now get an ephemeral reply and
are reported through `onError` instead of showing "This interaction failed" while the application
stays blind. Autocomplete interactions are answered with an empty result, and a rejected
`deferReply`/`deferUpdate` is reported instead of silently dropping the command or button click.
