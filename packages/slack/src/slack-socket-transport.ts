import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { splitChannelText } from "@anvia/channel";
import type {
  ChannelAttachmentData,
  ChannelMessage,
  ChannelOutboundAttachment,
} from "@anvia/channel";
import { isSlackDownloadUrl, isSlackId, isSlackTimestamp } from "./identifiers.js";
import { parseSlackSocketEvent, parseSlackSocketInteraction } from "./socket-event.js";
import type {
  SlackIdentity,
  SlackSentMessage,
  SlackTransport,
  SlackTransportHandler,
} from "./types.js";

const MAX_REMEMBERED_MESSAGES = 1_000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

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
  uploadFile(
    channelId: string,
    threadTimestamp: string | undefined,
    attachment: ChannelOutboundAttachment,
    maximumBytes: number,
  ): Promise<unknown>;
  downloadFile(
    url: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<ChannelAttachmentData>;
}>;

export type SlackSocketTransportOptions = Readonly<{
  appToken: string;
  botToken: string;
  fetch?: typeof globalThis.fetch;
  maximumAttachmentBytes?: number;
  onError?: (error: unknown) => void | Promise<void>;
}>;

export class SlackSocketTransport implements SlackTransport {
  private readonly socket: SocketModeClient;
  private readonly web: SlackWebClient;
  private readonly onError: SlackSocketTransportOptions["onError"];
  private readonly maximumAttachmentBytes: number;
  private readonly deliveries = new Set<Promise<void>>();
  private readonly rememberedMessages = new Set<string>();
  private slackEventListener: ((request: unknown) => void) | undefined;
  private socketErrorListener: ((error: unknown) => void) | undefined;
  private running = false;

  constructor(options: SlackSocketTransportOptions, webClient?: SlackWebClient) {
    validateToken(options.appToken, "Slack app-level token");
    validateToken(options.botToken, "Slack bot token");
    this.socket = new SocketModeClient({ appToken: options.appToken });
    this.web = webClient ?? slackWebClient(options.botToken, options.fetch ?? globalThis.fetch);
    this.onError = options.onError;
    this.maximumAttachmentBytes = options.maximumAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    if (!Number.isSafeInteger(this.maximumAttachmentBytes) || this.maximumAttachmentBytes <= 0) {
      throw new TypeError("Slack maximum attachment size must be a positive integer");
    }
    this.socket.on("reconnecting", () => {
      void this.reportError(new Error("Slack Socket Mode connection lost; reconnecting"));
    });
    this.socket.on("disconnected", () => {
      void this.reportError(new Error("Slack Socket Mode disconnected"));
    });
  }

  async start(handler: SlackTransportHandler): Promise<void> {
    if (this.running) {
      throw new Error("Slack Socket Mode transport is already running");
    }
    if (typeof handler !== "function") throw new TypeError("Slack transport handler is required");
    this.running = true;

    let identity: SlackIdentity;
    try {
      identity = await this.authenticate();
    } catch (error) {
      this.running = false;
      throw error;
    }
    if (!this.running) return;

    const slackEventListener = (request: unknown) => {
      let delivery: Promise<void>;
      delivery = this.receive(request, identity, handler)
        .catch((error: unknown) => this.reportError(error))
        .finally(() => this.deliveries.delete(delivery));
      this.deliveries.add(delivery);
    };
    const socketErrorListener = (error: unknown) => {
      void this.reportError(error);
    };

    this.socket.on("slack_event", slackEventListener);
    this.socket.on("error", socketErrorListener);
    this.slackEventListener = slackEventListener;
    this.socketErrorListener = socketErrorListener;

    try {
      await this.socket.start();
      if (!this.running) await this.socket.disconnect();
    } catch (error) {
      this.detachListeners(slackEventListener, socketErrorListener);
      this.running = false;
      try {
        await this.socket.disconnect();
      } catch (disconnectError) {
        await this.reportError(disconnectError);
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    const slackEventListener = this.slackEventListener;
    const socketErrorListener = this.socketErrorListener;
    if (slackEventListener === undefined || socketErrorListener === undefined) return;

    this.detachListeners(slackEventListener, socketErrorListener);
    try {
      await this.socket.disconnect();
    } finally {
      await Promise.all(this.deliveries);
    }
  }

  async send(
    channelId: string,
    threadTimestamp: string | undefined,
    message: ChannelMessage,
  ): Promise<SlackSentMessage> {
    const response = await this.web.postMessage(
      channelId,
      threadTimestamp,
      sanitizeSlackMessage(message),
    );
    for (const attachment of message.attachments ?? []) {
      await this.web.uploadFile(
        channelId,
        threadTimestamp,
        attachment,
        this.maximumAttachmentBytes,
      );
    }
    return sentMessage(response, threadTimestamp);
  }

  async edit(channelId: string, timestamp: string, message: ChannelMessage): Promise<void> {
    await this.web.updateMessage(channelId, timestamp, sanitizeSlackMessage(message));
  }

  async delete(channelId: string, timestamp: string): Promise<void> {
    await this.web.deleteMessage(channelId, timestamp);
  }

  async react(channelId: string, timestamp: string, reaction: string): Promise<void> {
    await this.web.addReaction(channelId, timestamp, reaction.replace(/^:|:$/g, ""));
  }

  async loadAttachment(
    file: Parameters<SlackTransport["loadAttachment"]>[0],
    signal?: AbortSignal,
  ): Promise<ChannelAttachmentData> {
    if (file.size !== undefined && file.size > this.maximumAttachmentBytes) {
      throw new RangeError(`Slack attachment must not exceed ${this.maximumAttachmentBytes} bytes`);
    }
    if (!isSlackDownloadUrl(file.privateDownloadUrl)) {
      throw new TypeError("Slack attachment download URL is not a Slack-controlled HTTPS URL");
    }
    return this.web.downloadFile(file.privateDownloadUrl, this.maximumAttachmentBytes, signal);
  }

  private async authenticate(): Promise<SlackIdentity> {
    const response = await this.web.authenticate();
    if (!isRecord(response) || !isSlackId(response.team_id) || !isSlackId(response.user_id)) {
      throw new TypeError("Slack auth.test response is invalid");
    }
    return { teamId: response.team_id, botUserId: response.user_id };
  }

  private async receive(
    value: unknown,
    identity: SlackIdentity,
    handler: SlackTransportHandler,
  ): Promise<void> {
    const request = socketRequest(value);
    if (request === undefined) return;
    await request.ack();
    const event =
      request.type === "events_api"
        ? parseSlackSocketEvent(request.body, identity)
        : request.type === "interactive"
          ? parseSlackSocketInteraction(request.body, identity)
          : undefined;
    if (event === undefined) return;
    const key = event.eventId;
    if (this.rememberedMessages.has(key)) return;
    remember(this.rememberedMessages, key);
    await handler(event);
  }

  private detachListeners(
    slackEventListener: (request: unknown) => void,
    socketErrorListener: (error: unknown) => void,
  ): void {
    this.socket.off("slack_event", slackEventListener);
    this.socket.off("error", socketErrorListener);
    if (this.slackEventListener === slackEventListener) {
      this.slackEventListener = undefined;
      this.socketErrorListener = undefined;
    }
  }

  private async reportError(error: unknown): Promise<void> {
    try {
      await this.onError?.(error);
    } catch {
      // Error observers must not terminate Socket Mode delivery.
    }
  }
}

function socketRequest(value: unknown):
  | Readonly<{
      type: string;
      body: unknown;
      ack: () => Promise<void>;
    }>
  | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.ack !== "function") {
    return undefined;
  }
  const ack = value.ack;
  return {
    type: value.type,
    body: value.body,
    ack: async () => ack(),
  };
}

function slackWebClient(
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
    uploadFile: async (channelId, threadTimestamp, attachment, maximumBytes) => {
      const file = await outboundAttachmentBytes(attachment, fetchImplementation, maximumBytes);
      const common = { file, filename: attachment.filename ?? "attachment" };
      return threadTimestamp === undefined
        ? client.files.uploadV2({ ...common, channel_id: channelId })
        : client.files.uploadV2({
            ...common,
            channel_id: channelId,
            thread_ts: threadTimestamp,
          });
    },
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
        return { type: "data", data: await readResponseBase64(response, maximumBytes) };
      } catch (error) {
        if (error instanceof RangeError || signal?.aborted === true) throw error;
        throw new Error("Slack file download failed");
      }
    },
  };
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
    // Fetch errors may contain a signed attachment URL.
    throw new Error("Slack attachment download failed");
  }
  if (!response.ok) {
    throw new Error(`Slack attachment download failed with HTTP ${response.status}`);
  }
  return Buffer.from(await readResponseBase64(response, maximumBytes), "base64");
}

async function readResponseBase64(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (declaredBytes > maximumBytes) {
      throw new RangeError(`Slack attachment must not exceed ${maximumBytes} bytes`);
    }
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (totalBytes + value.byteLength > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size violation is the useful error even if stream cancellation fails.
      }
      throw new RangeError(`Slack attachment must not exceed ${maximumBytes} bytes`);
    }
    chunks.push(value);
    totalBytes += value.byteLength;
  }
  return Buffer.concat(chunks, totalBytes).toString("base64");
}

function sentMessage(value: unknown, fallbackThread: string | undefined): SlackSentMessage {
  if (!isRecord(value) || !isSlackId(value.channel) || !isSlackTimestamp(value.ts)) {
    throw new TypeError("Slack chat.postMessage response is invalid");
  }
  const responseThread =
    isRecord(value.message) && isSlackTimestamp(value.message.thread_ts)
      ? value.message.thread_ts
      : fallbackThread;
  const sent: Mutable<SlackSentMessage> = {
    channelId: value.channel,
    timestamp: value.ts,
  };
  if (responseThread !== undefined) sent.threadTimestamp = responseThread;
  return sent;
}

function sanitizeSlackText(text: string): string {
  return text.replace(/<([@#!])([^>\n]+)>/g, "&lt;$1$2&gt;");
}

function sanitizeSlackMessage(message: ChannelMessage): ChannelMessage {
  const sanitized: {
    text: string;
    actions?: NonNullable<ChannelMessage["actions"]>;
    attachments?: NonNullable<ChannelMessage["attachments"]>;
    replyToMessageId?: string;
  } = {
    // Slack requires a text fallback even when the visible content is only a file.
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

function validateToken(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function remember(values: Set<string>, value: string): void {
  values.add(value);
  if (values.size <= MAX_REMEMBERED_MESSAGES) return;
  const oldest = values.values().next().value;
  if (oldest !== undefined) values.delete(oldest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
