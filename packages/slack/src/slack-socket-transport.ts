import { SocketModeClient } from "@slack/socket-mode";
import type { ChannelAttachmentData, ChannelMessage } from "@anvia/channel";
import { BoundedSet, isRecord, reportErrorSafely } from "@anvia/channel/adapter";
import type { Mutable } from "@anvia/channel/adapter";
import { ignoreSlackMissing } from "./file-delivery.js";
import { isSlackDownloadUrl, isSlackId, isSlackTimestamp } from "./identifiers.js";
import {
  createSlackWebClient,
  sanitizeSlackMessage,
  slackMessageBody,
} from "./slack-web-client.js";
import type { SlackWebClient } from "./slack-web-client.js";
import {
  parseSlackSocketCommand,
  parseSlackSocketEvent,
  parseSlackSocketInteraction,
} from "./socket-event.js";
import type {
  SlackIdentity,
  SlackSentMessage,
  SlackSocketEvent,
  SlackTransport,
  SlackTransportHandler,
} from "./types.js";

export { slackMessageBody };
export type { SlackWebClient };

const MAX_REMEMBERED_KEYS = 1_000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

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
  private readonly rememberedEvents = new BoundedSet<string>(MAX_REMEMBERED_KEYS);
  private readonly rememberedMessages = new BoundedSet<string>(MAX_REMEMBERED_KEYS);
  private slackEventListener: ((request: unknown) => void) | undefined;
  private socketErrorListener: ((error: unknown) => void) | undefined;
  private running = false;

  constructor(options: SlackSocketTransportOptions, webClient?: SlackWebClient) {
    validateToken(options.appToken, "Slack app-level token");
    validateToken(options.botToken, "Slack bot token");
    this.socket = new SocketModeClient({ appToken: options.appToken });
    this.web =
      webClient ?? createSlackWebClient(options.botToken, options.fetch ?? globalThis.fetch);
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
      const delivery: Promise<void> = this.receive(request, identity, handler)
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
    const sanitized = sanitizeSlackMessage(message);

    if ((message.attachments?.length ?? 0) > 0) {
      return this.web.postFileMessage(
        channelId,
        threadTimestamp,
        sanitized,
        this.maximumAttachmentBytes,
      );
    }

    return sentMessage(
      await this.web.postMessage(channelId, threadTimestamp, sanitized),
      threadTimestamp,
    );
  }

  async edit(channelId: string, timestamp: string, message: ChannelMessage): Promise<void> {
    await this.web.updateMessage(channelId, timestamp, sanitizeSlackMessage(message));
  }

  async delete(channelId: string, timestamp: string, fileIds?: readonly string[]): Promise<void> {
    if (fileIds === undefined || fileIds.length === 0) {
      await this.web.deleteMessage(channelId, timestamp);
      return;
    }

    const results = await Promise.allSettled(
      fileIds.map((fileId) =>
        ignoreSlackMissing(() => this.web.deleteFile(fileId), "file_not_found"),
      ),
    );
    const failures: unknown[] = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );

    try {
      await ignoreSlackMissing(
        () => this.web.deleteMessage(channelId, timestamp),
        "message_not_found",
      );
    } catch (error) {
      failures.push(error);
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "Slack message deletion was incomplete");
    }
  }

  async react(channelId: string, timestamp: string, reaction: string): Promise<void> {
    await this.web.addReaction(channelId, timestamp, reaction.replace(/^:|:$/g, ""));
  }

  async removeReaction(channelId: string, timestamp: string, reaction: string): Promise<void> {
    await this.web.removeReaction(channelId, timestamp, reaction.replace(/^:|:$/g, ""));
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
    let event: SlackSocketEvent | undefined;

    if (request.type === "events_api") {
      event = parseSlackSocketEvent(request.body, identity);
    } else if (request.type === "interactive") {
      event = parseSlackSocketInteraction(request.body, identity);
    } else if (request.type === "slash_commands") {
      event = parseSlackSocketCommand(request.body, identity);
    }

    if (event === undefined) return;

    const eventKey = `${request.type}:${event.eventId}`;

    if (this.rememberedEvents.has(eventKey)) return;

    this.rememberedEvents.add(eventKey);

    if (event.type === "message" || event.type === "app_mention") {
      const messageKey = `message:${event.teamId}:${event.channelId}:${event.timestamp}`;

      if (this.rememberedMessages.has(messageKey)) return;

      this.rememberedMessages.add(messageKey);
    }

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

  private reportError(error: unknown): Promise<void> {
    return reportErrorSafely(this.onError, error);
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

function validateToken(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}
