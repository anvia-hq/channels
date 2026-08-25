import type {
  Channel,
  ChannelAddress,
  ChannelEventHandler,
  ChannelMessage,
  SentChannelMessage,
} from "@anvia/channel";
import { DiscordJsGateway } from "./discord-js-gateway.js";
import { normalizeDiscordMessage } from "./normalize.js";
import { validateDiscordSnowflake } from "./snowflake.js";
import type { DiscordGateway, DiscordGatewayMessage } from "./types.js";

const MAX_MESSAGE_LENGTH = 2_000;

export type DiscordChannelErrorContext = Readonly<{
  operation: "gateway" | "handle";
  message?: DiscordGatewayMessage;
}>;

type DiscordChannelCommonOptions = Readonly<{
  onError?: (error: unknown, context: DiscordChannelErrorContext) => void | Promise<void>;
}>;

export type DiscordChannelOptions = DiscordChannelCommonOptions &
  (
    | Readonly<{
        token: string;
        messageContentIntent?: boolean;
        gateway?: never;
      }>
    | Readonly<{
        gateway: DiscordGateway;
        token?: never;
        messageContentIntent?: never;
      }>
  );

export function discord(options: DiscordChannelOptions): DiscordChannel {
  return new DiscordChannel(options);
}

export class DiscordChannel implements Channel<DiscordGatewayMessage> {
  readonly platform = "discord";

  private readonly gateway: DiscordGateway;
  private readonly onError: DiscordChannelCommonOptions["onError"];
  private running = false;

  constructor(options: DiscordChannelOptions) {
    this.onError = options.onError;
    this.gateway =
      options.gateway ??
      new DiscordJsGateway({
        token: options.token,
        ...(options.messageContentIntent === undefined
          ? {}
          : { messageContentIntent: options.messageContentIntent }),
        onError: (error) => this.reportError(error, { operation: "gateway" }),
      });
  }

  async start(handler: ChannelEventHandler<DiscordGatewayMessage>): Promise<void> {
    if (this.running) throw new Error("Discord channel is already running");
    if (typeof handler !== "function") throw new TypeError("Discord event handler is required");
    this.running = true;

    try {
      await this.gateway.start(async (message) => {
        const event = normalizeDiscordMessage(message);
        if (event === undefined || event.sender.bot) return;

        try {
          await handler(event);
        } catch (error) {
          await this.reportError(error, { operation: "handle", message });
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
    const sent = await this.gateway.send(targetChannelId, message.text);

    return {
      id: sent.id,
      address: {
        platform: this.platform,
        ...(address.accountId === undefined ? {} : { accountId: address.accountId }),
        conversationId: address.threadId === undefined ? sent.channelId : address.conversationId,
        ...(address.threadId === undefined ? {} : { threadId: sent.channelId }),
      },
    };
  }

  async edit(sent: SentChannelMessage, message: ChannelMessage): Promise<void> {
    validateAddress(sent.address);
    validateDiscordSnowflake(sent.id, "Discord message ID");
    validateMessage(message);
    await this.gateway.edit(
      sent.address.threadId ?? sent.address.conversationId,
      sent.id,
      message.text,
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
  if (typeof message.text !== "string" || message.text.length === 0) {
    throw new TypeError("Discord message text must not be empty");
  }
  if (message.text.length > MAX_MESSAGE_LENGTH) {
    throw new RangeError(`Discord message text must not exceed ${MAX_MESSAGE_LENGTH} characters`);
  }
}
