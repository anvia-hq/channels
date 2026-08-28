import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { ChannelAttachmentData } from "@anvia/channel";
import { isSlackId, isSlackTimestamp } from "./identifiers.js";
import { parseSlackSocketEvent } from "./socket-event.js";
import type {
  SlackIdentity,
  SlackSentMessage,
  SlackTransport,
  SlackTransportHandler,
} from "./types.js";

const MAX_REMEMBERED_MESSAGES = 1_000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type SlackWebClient = Readonly<{
  authenticate(): Promise<unknown>;
  postMessage(
    channelId: string,
    threadTimestamp: string | undefined,
    text: string,
  ): Promise<unknown>;
  updateMessage(channelId: string, timestamp: string, text: string): Promise<unknown>;
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
    text: string,
  ): Promise<SlackSentMessage> {
    const response = await this.web.postMessage(
      channelId,
      threadTimestamp,
      sanitizeSlackText(text),
    );
    return sentMessage(response, threadTimestamp);
  }

  async edit(channelId: string, timestamp: string, text: string): Promise<void> {
    await this.web.updateMessage(channelId, timestamp, sanitizeSlackText(text));
  }

  async loadAttachment(
    file: Parameters<SlackTransport["loadAttachment"]>[0],
    signal?: AbortSignal,
  ): Promise<ChannelAttachmentData> {
    if (file.size !== undefined && file.size > this.maximumAttachmentBytes) {
      throw new RangeError(`Slack attachment must not exceed ${this.maximumAttachmentBytes} bytes`);
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
    if (request.type !== "events_api") return;

    const message = parseSlackSocketEvent(request.body, identity);
    if (message === undefined) return;
    const key = `${message.teamId}:${message.channelId}:${message.timestamp}`;
    if (this.rememberedMessages.has(key)) return;
    remember(this.rememberedMessages, key);
    await handler(message);
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
    postMessage: (channelId, threadTimestamp, text) =>
      client.chat.postMessage({
        channel: channelId,
        text,
        ...(threadTimestamp === undefined ? {} : { thread_ts: threadTimestamp }),
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      }),
    updateMessage: (channelId, timestamp, text) =>
      client.chat.update({
        channel: channelId,
        ts: timestamp,
        text,
        link_names: false,
      }),
    downloadFile: async (url, maximumBytes, signal) => {
      try {
        const response = await fetchImplementation(url, {
          headers: { authorization: `Bearer ${botToken}` },
          redirect: "error",
          ...(signal === undefined ? {} : { signal }),
        });
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
  return {
    channelId: value.channel,
    timestamp: value.ts,
    ...(responseThread === undefined ? {} : { threadTimestamp: responseThread }),
  };
}

function sanitizeSlackText(text: string): string {
  return text.replace(/<([@#!])([^>\n]+)>/g, "&lt;$1$2&gt;");
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
