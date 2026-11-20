import { WebClient } from "@slack/web-api";
import { splitChannelText } from "@anvia/channel";
import type {
  ChannelAttachmentData,
  ChannelMessage,
  ChannelOutboundAttachment,
} from "@anvia/channel";
import { readBoundedResponseBuffer } from "@anvia/channel/adapter";
import { postSlackFiles } from "./file-delivery.js";
import { isSlackDownloadUrl } from "./identifiers.js";
import type { SlackSentMessage } from "./types.js";

export type SlackWebClient = Readonly<{
  authenticate(): Promise<unknown>;
  postMessage(
    channelId: string,
    threadTimestamp: string | undefined,
    message: ChannelMessage,
  ): Promise<unknown>;
  updateMessage(channelId: string, timestamp: string, message: ChannelMessage): Promise<unknown>;
  deleteMessage(channelId: string, timestamp: string): Promise<unknown>;
  addReaction(channelId: string, timestamp: string, reaction: string): Promise<unknown>;
  removeReaction(channelId: string, timestamp: string, reaction: string): Promise<unknown>;
  postFileMessage(
    channelId: string,
    threadTimestamp: string | undefined,
    message: ChannelMessage,
    maximumBytes: number,
  ): Promise<SlackSentMessage>;
  deleteFile(fileId: string): Promise<unknown>;
  downloadFile(
    url: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<ChannelAttachmentData>;
}>;

export function createSlackWebClient(
  botToken: string,
  fetchImplementation: typeof globalThis.fetch,
): SlackWebClient {
  const client = new WebClient(botToken);
  return {
    authenticate: () => client.auth.test(),
    postMessage: (channelId, threadTimestamp, message) => {
      const request = {
        channel: channelId,
        ...slackMessageBody(message),
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      } as Parameters<typeof client.chat.postMessage>[0];

      if (threadTimestamp !== undefined) request.thread_ts = threadTimestamp;

      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      return client.chat.postMessage(request);
    },
    updateMessage: (channelId, timestamp, message) =>
      client.chat.update({
        channel: channelId,
        ts: timestamp,
        ...slackMessageBody(message, true),
        link_names: false,
      } as Parameters<typeof client.chat.update>[0]),
    deleteMessage: (channelId, timestamp) =>
      client.chat.delete({ channel: channelId, ts: timestamp }),
    addReaction: (channelId, timestamp, reaction) =>
      client.reactions.add({ channel: channelId, timestamp, name: reaction }),
    removeReaction: (channelId, timestamp, reaction) =>
      client.reactions.remove({ channel: channelId, timestamp, name: reaction }),
    postFileMessage: async (channelId, threadTimestamp, message, maximumBytes) => {
      const files = [];
      for (const attachment of message.attachments ?? []) {
        files.push({
          file: await outboundAttachmentBytes(attachment, fetchImplementation, maximumBytes),
          filename: attachment.filename ?? "attachment",
        });
      }
      return postSlackFiles(
        client,
        fetchImplementation,
        channelId,
        threadTimestamp,
        slackMessageBody(message),
        files,
      );
    },
    deleteFile: (fileId) => client.files.delete({ file: fileId }),
    downloadFile: async (url, maximumBytes, signal) => {
      if (!isSlackDownloadUrl(url)) {
        throw new TypeError("Slack file download URL is not a Slack-controlled HTTPS URL");
      }

      try {
        const request: RequestInit = {
          headers: { authorization: `Bearer ${botToken}` },
          redirect: "error",
        };

        if (signal !== undefined) request.signal = signal;

        const response = await fetchImplementation(url, request);

        if (!response.ok) {
          throw new Error(`Slack file download failed with HTTP ${response.status}`);
        }

        const buffer = await readBoundedResponseBuffer(response, {
          maximumBytes,
          label: "Slack attachment",
        });
        return { type: "data", data: buffer.toString("base64") };
      } catch (error) {
        if (error instanceof RangeError || signal?.aborted === true) throw error;

        throw new Error("Slack file download failed", { cause: error });
      }
    },
  };
}

export function sanitizeSlackMessage(message: ChannelMessage): ChannelMessage {
  const sanitized: {
    text: string;
    actions?: NonNullable<ChannelMessage["actions"]>;
    attachments?: NonNullable<ChannelMessage["attachments"]>;
    replyToMessageId?: string;
  } = {
    text: message.text.length === 0 ? "\u200b" : sanitizeSlackText(message.text),
  };

  if (message.actions !== undefined) sanitized.actions = message.actions;

  if (message.attachments !== undefined) sanitized.attachments = message.attachments;

  if (message.replyToMessageId !== undefined) {
    sanitized.replyToMessageId = message.replyToMessageId;
  }

  return sanitized;
}

export function slackMessageBody(
  message: ChannelMessage,
  editing = false,
): Readonly<Record<string, unknown>> {
  const actions = message.actions;

  if (actions === undefined) {
    if (editing) return { text: message.text, blocks: [] };

    return { text: message.text };
  }

  return {
    text: message.text,
    blocks: [
      ...splitChannelText({ text: message.text, maximumLength: 3_000 }).map((text) => ({
        type: "section",
        text: { type: "mrkdwn", text },
      })),
      {
        type: "actions",
        elements: actions.map((action) => {
          const button: Record<string, unknown> = {
            type: "button",
            action_id: action.id,
            value: action.id,
            text: { type: "plain_text", text: action.label },
          };

          if (action.style !== undefined && action.style !== "default") {
            button.style = action.style;
          }

          return button;
        }),
      },
    ],
  };
}

function sanitizeSlackText(text: string): string {
  return text.replace(/<([@#!])([^>\n]+)>/g, "&lt;$1$2&gt;");
}

async function outboundAttachmentBytes(
  attachment: ChannelOutboundAttachment,
  fetchImplementation: typeof globalThis.fetch,
  maximumBytes: number,
): Promise<Buffer> {
  if (attachment.size !== undefined && attachment.size > maximumBytes) {
    throw new RangeError(`Slack attachment must not exceed ${maximumBytes} bytes`);
  }

  if (attachment.source.type === "data") {
    const bytes = Buffer.from(attachment.source.data, "base64");

    if (bytes.byteLength > maximumBytes) {
      throw new RangeError(`Slack attachment must not exceed ${maximumBytes} bytes`);
    }

    return bytes;
  }

  let response: Response;
  try {
    response = await fetchImplementation(attachment.source.url, { redirect: "error" });
  } catch {
    throw new Error("Slack attachment download failed");
  }

  if (!response.ok) {
    throw new Error(`Slack attachment download failed with HTTP ${response.status}`);
  }

  return readBoundedResponseBuffer(response, {
    maximumBytes,
    label: "Slack attachment",
  });
}
