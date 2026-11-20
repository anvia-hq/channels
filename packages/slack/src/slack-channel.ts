import type {
  Channel,
  ChannelAddress,
  ChannelAttachment,
  ChannelAttachmentData,
  ChannelEventHandler,
  ChannelMessage,
  ChannelMessageEvent,
  SentChannelMessage,
} from "@anvia/channel";
import { splitChannelMessage } from "@anvia/channel";
import { reportChannelError, validateOutboundChannelMessage } from "@anvia/channel/adapter";
import { parseSlackMessageId, validateSlackId, validateSlackTimestamp } from "./identifiers.js";
import { normalizeSlackEvent } from "./normalize.js";
import { SlackSocketTransport } from "./slack-socket-transport.js";
import type { SlackSocketEvent, SlackTransport } from "./types.js";

const MAX_MESSAGE_LENGTH = 4_000;

export type SlackChannelErrorContext = Readonly<{
  operation: "socket" | "handle";
  event?: SlackSocketEvent;
}>;

type SlackChannelCommonOptions = Readonly<{
  onError?: (error: unknown, context: SlackChannelErrorContext) => void | Promise<void>;
}>;

export type SlackChannelOptions = SlackChannelCommonOptions &
  (
    | Readonly<{
        appToken: string;
        botToken: string;
        fetch?: typeof globalThis.fetch;
        maximumAttachmentBytes?: number;
        transport?: never;
      }>
    | Readonly<{
        transport: SlackTransport;
        appToken?: never;
        botToken?: never;
        fetch?: never;
        maximumAttachmentBytes?: never;
      }>
  );

export function slack(options: SlackChannelOptions): SlackChannel {
  return new SlackChannel(options);
}

export class SlackChannel implements Channel<SlackSocketEvent> {
  readonly platform = "slack";
  readonly capabilities = {
    actions: true,
    outboundAttachments: ["image", "audio", "video", "file"],
    replies: true,
    reactions: true,
    reactionRemovals: true,
    delete: true,
    messageEdits: true,
  } as const;

  private readonly transport: SlackTransport;
  private readonly onError: SlackChannelCommonOptions["onError"];
  private running = false;

  constructor(options: SlackChannelOptions) {
    this.onError = options.onError;

    if (options.transport !== undefined && options.transport !== null) {
      this.transport = options.transport;
      return;
    }

    const transportOptions: {
      appToken: string;
      botToken: string;
      fetch?: typeof globalThis.fetch;
      maximumAttachmentBytes?: number;
      onError: (error: unknown) => Promise<void>;
    } = {
      appToken: options.appToken,
      botToken: options.botToken,
      onError: (error) => this.reportError(error, { operation: "socket" }),
    };

    if (options.fetch !== undefined) transportOptions.fetch = options.fetch;

    if (options.maximumAttachmentBytes !== undefined) {
      transportOptions.maximumAttachmentBytes = options.maximumAttachmentBytes;
    }

    this.transport = new SlackSocketTransport(transportOptions);
  }

  splitMessage(message: ChannelMessage): readonly ChannelMessage[] {
    const parts = splitChannelMessage({ message, maximumLength: MAX_MESSAGE_LENGTH });

    const replyToMessageId = message.replyToMessageId;

    if (replyToMessageId === undefined) return parts;

    return parts.map((part) =>
      part.replyToMessageId === undefined ? { ...part, replyToMessageId } : part,
    );
  }

  async loadAttachment(
    event: ChannelMessageEvent<SlackSocketEvent>,
    attachment: ChannelAttachment,
    signal?: AbortSignal,
  ): Promise<ChannelAttachmentData> {
    if (event.raw.type !== "message" && event.raw.type !== "app_mention") {
      throw new TypeError("Slack message raw event is invalid");
    }

    const file = event.raw.files.find((candidate) => candidate.id === attachment.id);

    if (file === undefined) throw new Error(`Slack attachment ${attachment.id} is unavailable`);

    return this.transport.loadAttachment(file, signal);
  }

  async start(handler: ChannelEventHandler<SlackSocketEvent>): Promise<void> {
    if (this.running) throw new Error("Slack channel is already running");

    if (typeof handler !== "function") throw new TypeError("Slack event handler is required");

    this.running = true;

    try {
      await this.transport.start(async (source) => {
        const event = normalizeSlackEvent(source);

        if (event === undefined || ("sender" in event && event.sender.bot)) return;

        try {
          await handler(event);
        } catch (error) {
          await this.reportError(error, { operation: "handle", event: source });
        }
      });
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    await this.transport.stop();
  }

  async send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage> {
    validateAddress(address);
    const replyTimestamp = validateMessage(message);
    const sent = await this.transport.send(
      address.conversationId,
      replyTimestamp ?? address.threadId,
      message,
    );

    const sentAddress: {
      platform: string;
      accountId?: string;
      conversationId: string;
      threadId?: string;
    } = {
      platform: this.platform,
      conversationId: sent.channelId,
    };

    if (address.accountId !== undefined) sentAddress.accountId = address.accountId;

    if (sent.threadTimestamp !== undefined) sentAddress.threadId = sent.threadTimestamp;

    const fileIds = sent.fileIds ?? [];
    return {
      id: [sent.timestamp, ...fileIds].join(":"),
      address: sentAddress,
    };
  }

  async edit(sent: SentChannelMessage, message: ChannelMessage): Promise<void> {
    const { timestamp } = validateSentMessage(sent);
    validateMessage(message);

    if (message.attachments !== undefined || message.replyToMessageId !== undefined) {
      throw new TypeError("Slack message attachments and replies cannot be edited");
    }

    await this.transport.edit(sent.address.conversationId, timestamp, message);
  }

  async delete(sent: SentChannelMessage): Promise<void> {
    const { timestamp, fileIds } = validateSentMessage(sent);

    if (fileIds.length === 0) await this.transport.delete(sent.address.conversationId, timestamp);
    else await this.transport.delete(sent.address.conversationId, timestamp, fileIds);
  }

  async react(sent: SentChannelMessage, reaction: string): Promise<void> {
    const { timestamp } = validateSentMessage(sent);

    if (typeof reaction !== "string" || reaction.length === 0) {
      throw new TypeError("Slack reaction must not be empty");
    }

    await this.transport.react(sent.address.conversationId, timestamp, reaction);
  }

  async unreact(sent: SentChannelMessage, reaction: string): Promise<void> {
    const { timestamp } = validateSentMessage(sent);

    if (typeof reaction !== "string" || reaction.length === 0) {
      throw new TypeError("Slack reaction must not be empty");
    }

    await this.transport.removeReaction(sent.address.conversationId, timestamp, reaction);
  }

  private reportError(error: unknown, context: SlackChannelErrorContext): Promise<void> {
    return reportChannelError(this.onError, error, context);
  }
}

function validateAddress(address: ChannelAddress): void {
  if (address.platform !== "slack") {
    throw new TypeError(`Slack channel cannot use a ${address.platform} address`);
  }

  validateSlackId(address.conversationId, "Slack conversation ID");

  if (address.threadId !== undefined) {
    validateSlackTimestamp(address.threadId, "Slack thread ID");
  }
}

function validateMessage(message: ChannelMessage): string | undefined {
  validateOutboundChannelMessage(message, {
    platformLabel: "Slack",
    maximumLength: MAX_MESSAGE_LENGTH,
  });

  if (message.replyToMessageId !== undefined) {
    return parseSlackMessageId(message.replyToMessageId).timestamp;
  }

  return undefined;
}

function validateSentMessage(
  sent: SentChannelMessage,
): Readonly<{ timestamp: string; fileIds: readonly string[] }> {
  validateAddress(sent.address);
  return parseSlackMessageId(sent.id);
}
