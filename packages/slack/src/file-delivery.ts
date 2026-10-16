import type { WebClient } from "@slack/web-api";
import { isSlackDownloadUrl, isSlackId, isSlackTimestamp } from "./identifiers.js";
import type { SlackSentMessage } from "./types.js";

/** Stage every file before publishing one message. Keep IDs even if completion fails. */
export async function postSlackFiles(
  client: WebClient,
  fetchImplementation: typeof globalThis.fetch,
  channelId: string,
  threadTimestamp: string | undefined,
  body: Readonly<Record<string, unknown>>,
  files: readonly Readonly<{ file: Buffer; filename: string }>[],
): Promise<SlackSentMessage> {
  const uploaded: { id: string; title: string }[] = [];
  let completionAttempted = false;
  try {
    for (const file of files) {
      const ticket = await client.files.getUploadURLExternal({
        filename: file.filename,
        length: file.file.byteLength,
      });
      if (ticket.ok !== true || !isSlackId(ticket.file_id) || !ticket.file_id.startsWith("F")) {
        throw new TypeError("Slack file upload ticket is invalid");
      }
      uploaded.push({ id: ticket.file_id, title: file.filename });
      if (!isSlackDownloadUrl(ticket.upload_url)) {
        throw new TypeError("Slack file upload URL is invalid");
      }
      let response: Response;
      try {
        response = await fetchImplementation(ticket.upload_url, {
          method: "POST",
          body: new Uint8Array(file.file),
          redirect: "error",
        });
      } catch {
        // Upload URLs are signed; do not expose them through fetch errors.
        throw new Error("Slack file upload failed");
      }
      if (!response.ok) throw new Error(`Slack file upload failed with HTTP ${response.status}`);
    }
    const request = {
      channel_id: channelId,
      files: uploaded,
      ...(body.blocks === undefined ? { initial_comment: body.text } : { blocks: body.blocks }),
      ...(threadTimestamp === undefined ? {} : { thread_ts: threadTimestamp }),
    } as Parameters<typeof client.files.completeUploadExternal>[0];
    completionAttempted = true;
    const result = await client.files.completeUploadExternal(request);
    if (result.ok !== true) throw new Error("Slack file upload completion failed");

    // Completion returns file IDs, not the message timestamp. Resolve the new share.
    const first = uploaded[0];
    if (first === undefined) throw new TypeError("Slack file message requires attachments");
    const timestamp = await uploadedMessageTimestamp(client, first.id, channelId, threadTimestamp);
    return {
      channelId,
      timestamp,
      fileIds: uploaded.map((file) => file.id),
      ...(threadTimestamp === undefined ? {} : { threadTimestamp }),
    };
  } catch (error) {
    const failures: unknown[] = [];
    const first = uploaded[0];
    if (completionAttempted && first !== undefined) {
      try {
        // Completion may have succeeded even when its response was lost. Resolve the
        // share before deleting files, which can erase the timestamp we need.
        const timestamp = await uploadedMessageTimestamp(
          client,
          first.id,
          channelId,
          threadTimestamp,
        );
        await ignoreSlackMissing(
          () => client.chat.delete({ channel: channelId, ts: timestamp }),
          "message_not_found",
        );
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    const cleanup = await Promise.allSettled(
      uploaded.map((file) =>
        ignoreSlackMissing(() => client.files.delete({ file: file.id }), "file_not_found"),
      ),
    );
    failures.push(
      ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        "Slack file delivery failed and cleanup was incomplete",
      );
    }
    throw error;
  }
}

async function uploadedMessageTimestamp(
  client: WebClient,
  fileId: string,
  channelId: string,
  threadTimestamp: string | undefined,
): Promise<string> {
  const info = await client.files.info({ file: fileId });
  const shares = info.file?.shares;
  const share = [
    ...(shares?.public?.[channelId] ?? []),
    ...(shares?.private?.[channelId] ?? []),
  ].find((candidate) => candidate.thread_ts === threadTimestamp && isSlackTimestamp(candidate.ts));
  if (info.ok !== true || !isSlackTimestamp(share?.ts)) {
    throw new TypeError("Slack uploaded file share timestamp is unavailable");
  }
  return share.ts;
}

export async function ignoreSlackMissing(
  operation: () => Promise<unknown>,
  missingCode: "file_not_found" | "message_not_found",
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "slack_webapi_platform_error" &&
      "data" in error &&
      typeof error.data === "object" &&
      error.data !== null &&
      "error" in error.data &&
      (error.data.error === missingCode ||
        (missingCode === "file_not_found" && error.data.error === "file_deleted"))
    )
      return;
    throw error;
  }
}
