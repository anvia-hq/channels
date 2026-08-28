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
import {
  splitChannelMessage,
  validateChannelActions,
  validateChannelAttachments,
} from "@anvia/channel";
import { DiscordJsGateway } from "./discord-js-gateway.js";
import { normalizeDiscordEvent } from "./normalize.js";
import { validateDiscordSnowflake } from "./snowflake.js";
import type { DiscordGateway, DiscordGatewayEvent } from "./types.js";

const MAX_MESSAGE_LENGTH = 2_000;

export type DiscordChannelErrorContext = Readonly<{
  operation: "gateway" | "handle";
  event?: DiscordGatewayEvent;
}>;

type DiscordChannelCommonOptions = Readonly<{
  onError?: (error: unknown, context: DiscordChannelErrorContext) => void | Promise<void>;
}>;

export type DiscordChannelOptions = DiscordChannelCommonOptions &
  (
    | Readonly<{
        token: string;
        messageContentIntent?: boolean;
        fetch?: typeof globalThis.fetch;
        maximumAttachmentBytes?: number;
        gateway?: never;
      }>
    | Readonly<{
        gateway: DiscordGateway;
        token?: never;
        messageContentIntent?: never;
        fetch?: never;
        maximumAttachmentBytes?: never;
      }>
  );

export function discord(options: DiscordChannelOptions): DiscordChannel {
  return new DiscordChannel(options);
}

export class DiscordChannel implements Channel<DiscordGatewayEvent> {
  readonly platform = "discord";
  readonly capabilities = {
    actions: true,
    outboundAttachments: ["image", "audio", "video", "file"],
    replies: true,
    typing: true,
    reactions: true,
    delete: true,
    messageEdits: true,
  } as const;

  private readonly gateway: DiscordGateway;
  private readonly onError: DiscordChannelCommonOptions["onError"];
  private running = false;

  constructor(options: DiscordChannelOptions) {
    this.onError = options.onError;
    if (options.gateway !== undefined && options.gateway !== null) {
      this.gateway = options.gateway;
      return;
    }

    const gatewayOptions: {
      token: string;
      messageContentIntent?: boolean;
      fetch?: typeof globalThis.fetch;
      maximumAttachmentBytes?: number;
      onError: (error: unknown) => Promise<void>;
    } = {
      token: options.token,
      onError: (error) => this.reportError(error, { operation: "gateway" }),
    };
    if (options.messageContentIntent !== undefined) {
      gatewayOptions.messageContentIntent = options.messageContentIntent;
    }
    if (options.fetch !== undefined) gatewayOptions.fetch = options.fetch;
    if (options.maximumAttachmentBytes !== undefined) {
      gatewayOptions.maximumAttachmentBytes = options.maximumAttachmentBytes;
    }
    this.gateway = new DiscordJsGateway(gatewayOptions);
  }

  splitMessage(message: ChannelMessage): readonly ChannelMessage[] {
    return splitChannelMessage(message, MAX_MESSAGE_LENGTH);
  }

  async loadAttachment(
    event: ChannelMessageEvent<DiscordGatewayEvent>,
    attachment: ChannelAttachment,
  ): Promise<ChannelAttachmentData> {
    if (event.raw.type !== "message") throw new TypeError("Discord message raw event is invalid");
    const source = event.raw.attachments.find((candidate) => candidate.id === attachment.id);
    if (source === undefined) throw new Error(`Discord attachment ${attachment.id} is unavailable`);
    return { type: "url", url: source.url };
  }

  async start(handler: ChannelEventHandler<DiscordGatewayEvent>): Promise<void> {
    if (this.running) throw new Error("Discord channel is already running");
    if (typeof handler !== "function") throw new TypeError("Discord event handler is required");
    this.running = true;

    try {
      await this.gateway.start(async (source) => {
        const event = normalizeDiscordEvent(source);
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
    await this.gateway.stop();
  }

  async send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage> {
    validateAddress(address);
    validateMessage(message);
    const targetChannelId = address.threadId ?? address.conversationId;
    const sent = await this.gateway.send(targetChannelId, message);

    const sentAddress: {
      platform: string;
      accountId?: string;
      conversationId: string;
      threadId?: string;
    } = {
      platform: this.platform,
      conversationId: address.threadId === undefined ? sent.channelId : address.conversationId,
    };
    if (address.accountId !== undefined) sentAddress.accountId = address.accountId;
    if (address.threadId !== undefined) sentAddress.threadId = sent.channelId;

    return {
      id: sent.id,
      address: sentAddress,
    };
  }

  async edit(sent: SentChannelMessage, message: ChannelMessage): Promise<void> {
    validateAddress(sent.address);
    validateDiscordSnowflake(sent.id, "Discord message ID");
    validateMessage(message);
    if (message.replyToMessageId !== undefined) {
      throw new TypeError("Discord reply targets cannot be edited");
    }
    await this.gateway.edit(sent.address.threadId ?? sent.address.conversationId, sent.id, message);
  }

  async delete(sent: SentChannelMessage): Promise<void> {
    validateSentMessage(sent);
    await this.gateway.delete(sent.address.threadId ?? sent.address.conversationId, sent.id);
  }

  async showTyping(address: ChannelAddress): Promise<void> {
    validateAddress(address);
    await this.gateway.showTyping(address.threadId ?? address.conversationId);
  }

  async react(sent: SentChannelMessage, reaction: string): Promise<void> {
    validateSentMessage(sent);
    if (typeof reaction !== "string" || reaction.length === 0) {
      throw new TypeError("Discord reaction must not be empty");
    }
    await this.gateway.react(
      sent.address.threadId ?? sent.address.conversationId,
      sent.id,
      reaction,
    );
  }

  private async reportError(error: unknown, context: DiscordChannelErrorContext): Promise<void> {
    try {
      await this.onError?.(error, context);
    } catch {
      // Error observers must not terminate message delivery.
    }
  }
}

function validateAddress(address: ChannelAddress): void {
  if (address.platform !== "discord") {
    throw new TypeError(`Discord channel cannot use a ${address.platform} address`);
  }
  validateDiscordSnowflake(address.conversationId, "Discord conversation ID");
  if (address.threadId !== undefined) {
    validateDiscordSnowflake(address.threadId, "Discord thread ID");
  }
}

function validateMessage(message: ChannelMessage): void {
  if (
    typeof message.text !== "string" ||
    (message.text.length === 0 && message.attachments === undefined)
  ) {
    throw new TypeError("Discord message must include text or attachments");
  }
  if (message.text.length > MAX_MESSAGE_LENGTH) {
    throw new RangeError(`Discord message text must not exceed ${MAX_MESSAGE_LENGTH} characters`);
  }
  validateChannelActions(message.actions);
  validateChannelAttachments(message.attachments);
  if (message.replyToMessageId !== undefined) {
    validateDiscordSnowflake(message.replyToMessageId, "Discord reply message ID");
  }
}

function validateSentMessage(sent: SentChannelMessage): void {
  validateAddress(sent.address);
  validateDiscordSnowflake(sent.id, "Discord message ID");
}
