import type {
  Channel,
  ChannelAddress,
  ChannelEventHandler,
  ChannelMessage,
  SentChannelMessage,
} from "@anvia/channel";
import { validateSlackId, validateSlackTimestamp } from "./identifiers.js";
import { normalizeSlackMessage } from "./normalize.js";
import { SlackSocketTransport } from "./slack-socket-transport.js";
import type { SlackSocketMessage, SlackTransport } from "./types.js";

const MAX_MESSAGE_LENGTH = 4_000;

export type SlackChannelErrorContext = Readonly<{
  operation: "socket" | "handle";
  message?: SlackSocketMessage;
}>;

type SlackChannelCommonOptions = Readonly<{
  onError?: (error: unknown, context: SlackChannelErrorContext) => void | Promise<void>;
}>;

export type SlackChannelOptions = SlackChannelCommonOptions &
  (
    | Readonly<{
        appToken: string;
        botToken: string;
        transport?: never;
      }>
    | Readonly<{
        transport: SlackTransport;
        appToken?: never;
        botToken?: never;
      }>
  );

export function slack(options: SlackChannelOptions): SlackChannel {
  return new SlackChannel(options);
}

export class SlackChannel implements Channel<SlackSocketMessage> {
  readonly platform = "slack";

  private readonly transport: SlackTransport;
  private readonly onError: SlackChannelCommonOptions["onError"];
  private running = false;

  constructor(options: SlackChannelOptions) {
    this.onError = options.onError;
    this.transport =
      options.transport ??
      new SlackSocketTransport({
        appToken: options.appToken,
        botToken: options.botToken,
        onError: (error) => this.reportError(error, { operation: "socket" }),
      });
  }

  async start(handler: ChannelEventHandler<SlackSocketMessage>): Promise<void> {
    if (this.running) throw new Error("Slack channel is already running");
    if (typeof handler !== "function") throw new TypeError("Slack event handler is required");
    this.running = true;

    try {
      await this.transport.start(async (message) => {
        const event = normalizeSlackMessage(message);
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
    await this.transport.stop();
  }

  async send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage> {
    validateAddress(address);
    validateMessage(message);
    const sent = await this.transport.send(address.conversationId, address.threadId, message.text);

    return {
      id: sent.timestamp,
      address: {
        platform: this.platform,
        ...(address.accountId === undefined ? {} : { accountId: address.accountId }),
        conversationId: sent.channelId,
        ...(sent.threadTimestamp === undefined ? {} : { threadId: sent.threadTimestamp }),
      },
    };
  }

  async edit(sent: SentChannelMessage, message: ChannelMessage): Promise<void> {
    validateAddress(sent.address);
    validateSlackTimestamp(sent.id, "Slack message ID");
    validateMessage(message);
    await this.transport.edit(sent.address.conversationId, sent.id, message.text);
  }

  private async reportError(error: unknown, context: SlackChannelErrorContext): Promise<void> {
    try {
      await this.onError?.(error, context);
    } catch {
      // Error observers must not terminate message delivery.
    }
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

function validateMessage(message: ChannelMessage): void {
  if (typeof message.text !== "string" || message.text.length === 0) {
    throw new TypeError("Slack message text must not be empty");
  }
  if (message.text.length > MAX_MESSAGE_LENGTH) {
    throw new RangeError(`Slack message text must not exceed ${MAX_MESSAGE_LENGTH} characters`);
  }
}
