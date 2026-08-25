import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type Message,
} from "discord.js";
import { isDiscordSnowflake } from "./snowflake.js";
import type {
  DiscordGateway,
  DiscordGatewayHandler,
  DiscordGatewayMessage,
  DiscordGatewaySentMessage,
  DiscordGatewayUser,
} from "./types.js";

type DiscordRestClient = Readonly<{
  post(route: string, options: Readonly<{ body: unknown }>): Promise<unknown>;
  patch(route: string, options: Readonly<{ body: unknown }>): Promise<unknown>;
}>;

export type DiscordJsGatewayOptions = Readonly<{
  token: string;
  messageContentIntent?: boolean;
  onError?: (error: unknown) => void | Promise<void>;
}>;

export class DiscordJsGateway implements DiscordGateway {
  private readonly token: string;
  private readonly messageContentIntent: boolean;
  private readonly onError: DiscordJsGatewayOptions["onError"];
  private readonly rest: DiscordRestClient;
  private client: Client | undefined;
  private readonly deliveries = new Set<Promise<void>>();
  private messageListener: ((message: Message) => void) | undefined;
  private errorListener: ((error: Error) => void) | undefined;

  constructor(options: DiscordJsGatewayOptions, rest?: DiscordRestClient) {
    if (typeof options.token !== "string" || options.token.trim().length === 0) {
      throw new TypeError("Discord bot token must not be empty");
    }
    this.token = options.token;
    this.messageContentIntent = options.messageContentIntent ?? true;
    this.onError = options.onError;
    this.rest = rest ?? new REST({ version: "10" }).setToken(options.token);
  }

  async start(handler: DiscordGatewayHandler): Promise<void> {
    if (this.client !== undefined) throw new Error("Discord gateway is already running");
    if (typeof handler !== "function") throw new TypeError("Discord gateway handler is required");

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        ...(this.messageContentIntent ? [GatewayIntentBits.MessageContent] : []),
      ],
      partials: [Partials.Channel],
    });
    const messageListener = (message: Message) => {
      let delivery: Promise<void>;
      delivery = Promise.resolve()
        .then(async () => {
          const gatewayMessage = gatewayMessageFromDiscord(message, client);
          if (gatewayMessage !== undefined) await handler(gatewayMessage);
        })
        .catch((error: unknown) => this.reportError(error))
        .finally(() => this.deliveries.delete(delivery));
      this.deliveries.add(delivery);
    };
    const errorListener = (error: Error) => {
      void this.reportError(error);
    };

    client.on(Events.MessageCreate, messageListener);
    client.on(Events.Error, errorListener);
    this.client = client;
    this.messageListener = messageListener;
    this.errorListener = errorListener;

    try {
      await client.login(this.token);
      if (client.user === null) throw new Error("Discord gateway started without a bot user");
    } catch (error) {
      this.detachClient(client, messageListener, errorListener);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    const messageListener = this.messageListener;
    const errorListener = this.errorListener;
    if (client === undefined || messageListener === undefined || errorListener === undefined)
      return;

    this.detachClient(client, messageListener, errorListener);
    await Promise.all(this.deliveries);
  }

  async send(channelId: string, text: string): Promise<DiscordGatewaySentMessage> {
    const response = await this.rest.post(Routes.channelMessages(channelId), {
      body: messageBody(text),
    });
    return sentMessage(response);
  }

  async edit(channelId: string, messageId: string, text: string): Promise<void> {
    await this.rest.patch(Routes.channelMessage(channelId, messageId), {
      body: messageBody(text),
    });
  }

  private detachClient(
    client: Client,
    messageListener: (message: Message) => void,
    errorListener: (error: Error) => void,
  ): void {
    client.off(Events.MessageCreate, messageListener);
    client.off(Events.Error, errorListener);
    client.destroy();
    if (this.client === client) {
      this.client = undefined;
      this.messageListener = undefined;
      this.errorListener = undefined;
    }
  }

  private async reportError(error: unknown): Promise<void> {
    try {
      await this.onError?.(error);
    } catch {
      // Error observers must not terminate Gateway delivery.
    }
  }
}

function gatewayMessageFromDiscord(
  message: Message,
  client: Client,
): DiscordGatewayMessage | undefined {
  const bot = client.user;
  if (bot === null) return undefined;
  const thread = message.channel.isThread();

  return {
    id: message.id,
    channelId: message.channelId,
    ...(message.guildId === null ? {} : { guildId: message.guildId }),
    ...(thread && message.channel.parentId !== null
      ? { parentChannelId: message.channel.parentId }
      : {}),
    content: message.content,
    author: gatewayUser(message.author),
    bot: gatewayUser(bot),
    ...(message.member === null ? {} : { memberDisplayName: message.member.displayName }),
    direct: message.channel.isDMBased(),
    thread,
    system: message.system,
    mentionedBot: message.mentions.users.has(bot.id) || message.mentions.repliedUser?.id === bot.id,
  };
}

function gatewayUser(user: Message["author"]): DiscordGatewayUser {
  return {
    id: user.id,
    username: user.username,
    ...(user.globalName === null ? {} : { globalName: user.globalName }),
    bot: user.bot,
  };
}

function messageBody(text: string): Readonly<Record<string, unknown>> {
  return {
    content: text,
    allowed_mentions: { parse: [] },
  };
}

function sentMessage(value: unknown): DiscordGatewaySentMessage {
  if (!isRecord(value) || !isDiscordSnowflake(value.id) || !isDiscordSnowflake(value.channel_id)) {
    throw new TypeError("Discord create-message response is invalid");
  }
  return { id: value.id, channelId: value.channel_id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
