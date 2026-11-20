import type { WebClient } from "@slack/web-api";
import { isSlackDownloadUrl, isSlackId, isSlackTimestamp } from "./identifiers.js";
import type { SlackSentMessage } from "./types.js";

export class SlackFileDeliveryError extends AggregateError {
  readonly retryCleanup: () => Promise<void>;

  constructor(errors: readonly unknown[], retryCleanup: () => Promise<void>) {
    super(errors, "Slack file delivery failed and cleanup was incomplete");
    this.name = "SlackFileDeliveryError";
    this.retryCleanup = retryCleanup;
  }
}

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
  let timestamp: string | undefined;

  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = [];

    if (completionAttempted && uploaded.length > 0) {
      timestamp ??= await uploadedMessageTimestamp(client, uploaded, channelId, threadTimestamp);
      const shareTimestamp = timestamp;
      try {
        await ignoreSlackMissing(
          () => client.chat.delete({ channel: channelId, ts: shareTimestamp }),
          "message_not_found",
        );
      } catch (error) {
        failures.push(error);
      }
    }

    const results = await Promise.allSettled(
      uploaded.map((file) =>
        ignoreSlackMissing(() => client.files.delete({ file: file.id }), "file_not_found"),
      ),
    );
    failures.push(
      ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );

    if (failures.length > 0)
      throw new AggregateError(failures, "Slack file cleanup was incomplete");
  };
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
        throw new Error("Slack file upload failed");
      }

      if (!response.ok) throw new Error(`Slack file upload failed with HTTP ${response.status}`);
    }
    const requestPayload: {
      channel_id: string;
      files: typeof uploaded;
      initial_comment?: unknown;
      blocks?: unknown;
      thread_ts?: string;
    } = {
      channel_id: channelId,
      files: uploaded,
    };

    if (body.blocks === undefined) {
      requestPayload.initial_comment = body.text;
    } else {
      requestPayload.blocks = body.blocks;
    }

    if (threadTimestamp !== undefined) {
      requestPayload.thread_ts = threadTimestamp;
    }

    const request = requestPayload as Parameters<typeof client.files.completeUploadExternal>[0];
    completionAttempted = true;
    const result = await client.files.completeUploadExternal(request);

    if (result.ok !== true) throw new Error("Slack file upload completion failed");

    timestamp = await uploadedMessageTimestamp(client, uploaded, channelId, threadTimestamp);
    const sent: {
      channelId: string;
      timestamp: string;
      fileIds: readonly string[];
      threadTimestamp?: string;
    } = {
      channelId,
      timestamp,
      fileIds: uploaded.map((file) => file.id),
    };

    if (threadTimestamp !== undefined) {
      sent.threadTimestamp = threadTimestamp;
    }

    return sent;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      const cleanupErrors =
        cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
      throw new SlackFileDeliveryError([error, ...cleanupErrors], cleanup);
    }
    throw error;
  }
}

async function uploadedMessageTimestamp(
  client: WebClient,
  files: readonly Readonly<{ id: string }>[],
  channelId: string,
  threadTimestamp: string | undefined,
): Promise<string> {
  if (files.length === 0) throw new TypeError("Slack file message requires attachments");

  let failure: unknown;

  for (const delay of [0, 250, 1_000, 2_000]) {
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));

    for (const file of files) {
      try {
        const info = await client.files.info({ file: file.id });
        const shares = info.file?.shares;
        const publicShares = shares?.public?.[channelId] ?? [];
        const privateShares = shares?.private?.[channelId] ?? [];
        const share = [...publicShares, ...privateShares].find(
          (candidate) => candidate.thread_ts === threadTimestamp && isSlackTimestamp(candidate.ts),
        );

        if (info.ok !== true || !isSlackTimestamp(share?.ts)) {
          throw new TypeError("Slack uploaded file share timestamp is unavailable");
        }

        return share.ts;
      } catch (error) {
        failure = error;
      }
    }
  }
  throw failure;
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
