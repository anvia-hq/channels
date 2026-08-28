import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type ButtonInteraction,
  type Interaction,
  type Message,
} from "discord.js";
import { isDiscordSnowflake } from "./snowflake.js";
import type {
  DiscordGateway,
  DiscordGatewayAction,
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
  private interactionListener: ((interaction: Interaction) => void) | undefined;
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
    const interactionListener = (interaction: Interaction) => {
      let delivery: Promise<void>;
      delivery = Promise.resolve()
        .then(async () => {
          if (!interaction.isButton()) return;
          const action = gatewayActionFromDiscord(interaction, client);
          if (action === undefined) return;
          await interaction.deferUpdate();
          await handler(action);
        })
        .catch((error: unknown) => this.reportError(error))
        .finally(() => this.deliveries.delete(delivery));
      this.deliveries.add(delivery);
    };
    const errorListener = (error: Error) => {
      void this.reportError(error);
    };

    client.on(Events.MessageCreate, messageListener);
    client.on(Events.InteractionCreate, interactionListener);
    client.on(Events.Error, errorListener);
    this.client = client;
    this.messageListener = messageListener;
    this.interactionListener = interactionListener;
    this.errorListener = errorListener;

    try {
      await client.login(this.token);
      if (client.user === null) throw new Error("Discord gateway started without a bot user");
    } catch (error) {
      this.detachClient(client, messageListener, interactionListener, errorListener);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    const messageListener = this.messageListener;
    const interactionListener = this.interactionListener;
    const errorListener = this.errorListener;
    if (
      client === undefined ||
      messageListener === undefined ||
      interactionListener === undefined ||
      errorListener === undefined
    )
      return;

    this.detachClient(client, messageListener, interactionListener, errorListener);
    await Promise.all(this.deliveries);
  }

  async send(
    channelId: string,
    message: Parameters<DiscordGateway["send"]>[1],
  ): Promise<DiscordGatewaySentMessage> {
    const response = await this.rest.post(Routes.channelMessages(channelId), {
      body: messageBody(message),
    });
    return sentMessage(response);
  }

  async edit(
    channelId: string,
    messageId: string,
    message: Parameters<DiscordGateway["edit"]>[2],
  ): Promise<void> {
    await this.rest.patch(Routes.channelMessage(channelId, messageId), {
      body: messageBody(message),
    });
  }

  private detachClient(
    client: Client,
    messageListener: (message: Message) => void,
    interactionListener: (interaction: Interaction) => void,
    errorListener: (error: Error) => void,
  ): void {
    client.off(Events.MessageCreate, messageListener);
    client.off(Events.InteractionCreate, interactionListener);
    client.off(Events.Error, errorListener);
    client.destroy();
    if (this.client === client) {
      this.client = undefined;
      this.messageListener = undefined;
      this.interactionListener = undefined;
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
    type: "message",
    id: message.id,
    channelId: message.channelId,
    ...(message.guildId === null ? {} : { guildId: message.guildId }),
    ...(thread && message.channel.parentId !== null
      ? { parentChannelId: message.channel.parentId }
      : {}),
    content: message.content,
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      url: attachment.url,
      filename: attachment.name,
      ...(attachment.contentType === null ? {} : { mediaType: attachment.contentType }),
      size: attachment.size,
    })),
    author: gatewayUser(message.author),
    bot: gatewayUser(bot),
    ...(message.member === null ? {} : { memberDisplayName: message.member.displayName }),
    direct: message.channel.isDMBased(),
    thread,
    system: message.system,
    mentionedBot: message.mentions.users.has(bot.id) || message.mentions.repliedUser?.id === bot.id,
  };
}

function gatewayActionFromDiscord(
  interaction: ButtonInteraction,
  client: Client,
): DiscordGatewayAction | undefined {
  const bot = client.user;
  const channel = interaction.channel;
  if (bot === null || channel === null) return undefined;
  const thread = channel.isThread();
  return {
    type: "action",
    id: interaction.id,
    channelId: interaction.channelId,
    ...(interaction.guildId === null ? {} : { guildId: interaction.guildId }),
    ...(thread && channel.parentId !== null ? { parentChannelId: channel.parentId } : {}),
    messageId: interaction.message.id,
    actionId: interaction.customId,
    user: gatewayUser(interaction.user),
    bot: gatewayUser(bot),
    direct: channel.isDMBased(),
    thread,
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

function messageBody(
  message: Parameters<DiscordGateway["send"]>[1],
): Readonly<Record<string, unknown>> {
  return {
    content: message.text,
    allowed_mentions: { parse: [] },
    components:
      message.actions === undefined
        ? []
        : [
            {
              type: 1,
              components: message.actions.map((action) => ({
                type: 2,
                style: action.style === "primary" ? 1 : action.style === "danger" ? 4 : 2,
                label: action.label,
                custom_id: action.id,
              })),
            },
          ],
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
