---
"@anvia/slack": minor
---

Publish Slack attachments and accompanying text or actions as one file message, cleaning up known uploads on failure. Preserve file IDs in sent message handles so deletion removes the files and message across retries and process restarts.

File-message IDs are now opaque handles rather than bare timestamps. Custom `SlackWebClient` implementations must replace `uploadFile` with `postFileMessage` and `deleteFile`; custom transports can return `SlackSentMessage.fileIds` and accept them as the optional third argument to `delete`. Outbound file messages require `files:read` as well as `files:write` to resolve the sent timestamp.
