---
"@anvia/channel": patch
"@anvia/channel-agent": patch
"@anvia/discord": patch
"@anvia/slack": patch
"@anvia/telegram": patch
---

Refresh dependencies across the workspace and generate declarations with `tsc --emitDeclarationOnly` instead of tsup's bundled DTS step, which no longer works on TypeScript 7 (the native compiler exposes no `ts.sys`, and tsup injects the `baseUrl` option that TypeScript 7 removed). The public API surface is unchanged: every entry point still exports the same symbols. `@anvia/slack` picks up `@slack/web-api` 8.1.1, `@slack/socket-mode` 3.0.1 and `undici` 7.30.0.
