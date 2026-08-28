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
  type ClientEvents,
  type MessageReaction,
  type User,
} from "discord.js";
import { isDiscordSnowflake } from "./snowflake.js";
import type {
  DiscordGateway,
  DiscordGatewayAction,
  DiscordGatewayAttachment,
  DiscordGatewayEvent,
  DiscordGatewayHandler,
  DiscordGatewayMessage,
  DiscordGatewayMessageDeleted,
  DiscordGatewayMessageEdited,
  DiscordGatewayReaction,
  DiscordGatewaySentMessage,
  DiscordGatewayUser,
} from "./types.js";

type DiscordRestClient = Readonly<{
  post(route: `/${string}`, options?: RestRequest): Promise<unknown>;
  patch(route: `/${string}`, options?: RestRequest): Promise<unknown>;
  delete(route: `/${string}`): Promise<unknown>;
  put(route: `/${string}`): Promise<unknown>;
}>;

type RestRequest = Readonly<{
  body?: unknown;
  files?: { data: Buffer; name: string }[];
}>;

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type MessageUpdateListener = (...args: ClientEvents[Events.MessageUpdate]) => void;
type MessageDeleteListener = (...args: ClientEvents[Events.MessageDelete]) => void;
type ReactionAddListener = (...args: ClientEvents[Events.MessageReactionAdd]) => void;
type ReactionRemoveListener = (...args: ClientEvents[Events.MessageReactionRemove]) => void;

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export type DiscordJsGatewayOptions = Readonly<{
  token: string;
  messageContentIntent?: boolean;
  fetch?: typeof globalThis.fetch;
  maximumAttachmentBytes?: number;
  onError?: (error: unknown) => void | Promise<void>;
}>;

export class DiscordJsGateway implements DiscordGateway {
  private readonly token: string;
  private readonly messageContentIntent: boolean;
  private readonly onError: DiscordJsGatewayOptions["onError"];
  private readonly rest: DiscordRestClient;
  private readonly fetch: typeof globalThis.fetch;
  private readonly maximumAttachmentBytes: number;
  private client: Client | undefined;
  private readonly deliveries = new Set<Promise<void>>();
  private messageListener: ((message: Message) => void) | undefined;
  private interactionListener: ((interaction: Interaction) => void) | undefined;
  private messageUpdateListener: MessageUpdateListener | undefined;
  private messageDeleteListener: MessageDeleteListener | undefined;
  private reactionAddListener: ReactionAddListener | undefined;
  private reactionRemoveListener: ReactionRemoveListener | undefined;
  private errorListener: ((error: Error) => void) | undefined;

  constructor(options: DiscordJsGatewayOptions, rest?: DiscordRestClient) {
    if (typeof options.token !== "string" || options.token.trim().length === 0) {
      throw new TypeError("Discord bot token must not be empty");
    }
    this.token = options.token;
    this.messageContentIntent = options.messageContentIntent ?? true;
    this.onError = options.onError;
    if (rest === undefined) {
      const client = new REST({ version: "10" }).setToken(options.token);
      this.rest = {
        post: (route, request) => client.post(route, request),
        patch: (route, request) => client.patch(route, request),
        delete: (route) => client.delete(route),
        put: (route) => client.put(route),
      };
    } else {
      this.rest = rest;
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maximumAttachmentBytes = options.maximumAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    if (typeof this.fetch !== "function")
      throw new TypeError("A Fetch API implementation is required");
    if (!Number.isSafeInteger(this.maximumAttachmentBytes) || this.maximumAttachmentBytes <= 0) {
      throw new TypeError("Discord maximum attachment size must be a positive integer");
    }
  }

  async start(handler: DiscordGatewayHandler): Promise<void> {
    if (this.client !== undefined) throw new Error("Discord gateway is already running");
    if (typeof handler !== "function") throw new TypeError("Discord gateway handler is required");

    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ];
    if (this.messageContentIntent) intents.push(GatewayIntentBits.MessageContent);

    const client = new Client({
      intents,
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
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
    const deliver = (
      createEvent: () => DiscordGatewayEvent | undefined | Promise<DiscordGatewayEvent | undefined>,
    ) => {
      let delivery: Promise<void>;
      delivery = Promise.resolve()
        .then(createEvent)
        .then(async (event) => {
          if (event !== undefined) await handler(event);
        })
        .catch((error: unknown) => this.reportError(error))
        .finally(() => this.deliveries.delete(delivery));
      this.deliveries.add(delivery);
    };
    const messageUpdateListener: MessageUpdateListener = (_oldMessage, newMessage) => {
      deliver(() => gatewayEditedMessageFromDiscord(newMessage, client));
    };
    const messageDeleteListener: MessageDeleteListener = (message) => {
      deliver(() => gatewayDeletedMessageFromDiscord(message, client));
    };
    const reactionAddListener: ReactionAddListener = (reaction, user) => {
      deliver(async () => {
        const completeReaction = reaction.partial ? await reaction.fetch() : reaction;
        const completeUser = user.partial ? await client.users.fetch(user.id) : user;
        return gatewayReactionFromDiscord(completeReaction, completeUser, client, false);
      });
    };
    const reactionRemoveListener: ReactionRemoveListener = (reaction, user) => {
      deliver(async () => {
        const completeReaction = reaction.partial ? await reaction.fetch() : reaction;
        const completeUser = user.partial ? await client.users.fetch(user.id) : user;
        return gatewayReactionFromDiscord(completeReaction, completeUser, client, true);
      });
    };
    const errorListener = (error: Error) => {
      void this.reportError(error);
    };

    client.on(Events.MessageCreate, messageListener);
    client.on(Events.InteractionCreate, interactionListener);
    client.on(Events.MessageUpdate, messageUpdateListener);
    client.on(Events.MessageDelete, messageDeleteListener);
    client.on(Events.MessageReactionAdd, reactionAddListener);
    client.on(Events.MessageReactionRemove, reactionRemoveListener);
    client.on(Events.Error, errorListener);
    this.client = client;
    this.messageListener = messageListener;
    this.interactionListener = interactionListener;
    this.messageUpdateListener = messageUpdateListener;
    this.messageDeleteListener = messageDeleteListener;
    this.reactionAddListener = reactionAddListener;
    this.reactionRemoveListener = reactionRemoveListener;
    this.errorListener = errorListener;

    try {
      await client.login(this.token);
      if (client.user === null) throw new Error("Discord gateway started without a bot user");
    } catch (error) {
      this.detachClient(
        client,
        messageListener,
        interactionListener,
        messageUpdateListener,
        messageDeleteListener,
        reactionAddListener,
        reactionRemoveListener,
        errorListener,
      );
      throw error;
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    const messageListener = this.messageListener;
    const interactionListener = this.interactionListener;
    const messageUpdateListener = this.messageUpdateListener;
    const messageDeleteListener = this.messageDeleteListener;
    const reactionAddListener = this.reactionAddListener;
    const reactionRemoveListener = this.reactionRemoveListener;
    const errorListener = this.errorListener;
    if (
      client === undefined ||
      messageListener === undefined ||
      interactionListener === undefined ||
      messageUpdateListener === undefined ||
      messageDeleteListener === undefined ||
      reactionAddListener === undefined ||
      reactionRemoveListener === undefined ||
      errorListener === undefined
    )
      return;

    this.detachClient(
      client,
      messageListener,
      interactionListener,
      messageUpdateListener,
      messageDeleteListener,
      reactionAddListener,
      reactionRemoveListener,
      errorListener,
    );
    await Promise.all(this.deliveries);
  }

  async send(
    channelId: string,
    message: Parameters<DiscordGateway["send"]>[1],
  ): Promise<DiscordGatewaySentMessage> {
    const files = await discordFiles(message, this.fetch, this.maximumAttachmentBytes);
    const request: {
      body: Readonly<Record<string, unknown>>;
      files?: NonNullable<RestRequest["files"]>;
    } = {
      body: messageBody(message),
    };
    if (files.length > 0) request.files = files;
    const response = await this.rest.post(Routes.channelMessages(channelId), request);
    return sentMessage(response);
  }

  async edit(
    channelId: string,
    messageId: string,
    message: Parameters<DiscordGateway["edit"]>[2],
  ): Promise<void> {
    const files = await discordFiles(message, this.fetch, this.maximumAttachmentBytes);
    const request: {
      body: Readonly<Record<string, unknown>>;
      files?: NonNullable<RestRequest["files"]>;
    } = {
      body: messageBody(message),
    };
    if (files.length > 0) request.files = files;
    await this.rest.patch(Routes.channelMessage(channelId, messageId), request);
  }

  async delete(channelId: string, messageId: string): Promise<void> {
    await this.rest.delete(Routes.channelMessage(channelId, messageId));
  }

  async showTyping(channelId: string): Promise<void> {
    await this.rest.post(Routes.channelTyping(channelId), {});
  }

  async react(channelId: string, messageId: string, reaction: string): Promise<void> {
    await this.rest.put(Routes.channelMessageOwnReaction(channelId, messageId, reaction));
  }

  private detachClient(
    client: Client,
    messageListener: (message: Message) => void,
    interactionListener: (interaction: Interaction) => void,
    messageUpdateListener: MessageUpdateListener,
    messageDeleteListener: MessageDeleteListener,
    reactionAddListener: ReactionAddListener,
    reactionRemoveListener: ReactionRemoveListener,
    errorListener: (error: Error) => void,
  ): void {
    client.off(Events.MessageCreate, messageListener);
    client.off(Events.InteractionCreate, interactionListener);
    client.off(Events.MessageUpdate, messageUpdateListener);
    client.off(Events.MessageDelete, messageDeleteListener);
    client.off(Events.MessageReactionAdd, reactionAddListener);
    client.off(Events.MessageReactionRemove, reactionRemoveListener);
    client.off(Events.Error, errorListener);
    client.destroy();
    if (this.client === client) {
      this.client = undefined;
      this.messageListener = undefined;
      this.interactionListener = undefined;
      this.messageUpdateListener = undefined;
      this.messageDeleteListener = undefined;
      this.reactionAddListener = undefined;
      this.reactionRemoveListener = undefined;
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
  const parentChannelId = message.channel.isThread() ? message.channel.parentId : null;

  const attachments = message.attachments.map((attachment) => {
    const gatewayAttachment: Mutable<DiscordGatewayAttachment> = {
      id: attachment.id,
      url: attachment.url,
      filename: attachment.name,
      size: attachment.size,
    };
    if (attachment.contentType !== null) gatewayAttachment.mediaType = attachment.contentType;
    return gatewayAttachment;
  });
  const gatewayMessage: Mutable<DiscordGatewayMessage> = {
    type: "message",
    id: message.id,
    channelId: message.channelId,
    content: message.content,
    attachments,
    author: gatewayUser(message.author),
    bot: gatewayUser(bot),
    direct: message.channel.isDMBased(),
    thread,
    system: message.system,
    mentionedBot: message.mentions.users.has(bot.id) || message.mentions.repliedUser?.id === bot.id,
  };
  if (message.guildId !== null) gatewayMessage.guildId = message.guildId;
  if (parentChannelId !== null) gatewayMessage.parentChannelId = parentChannelId;
  if (message.member !== null) gatewayMessage.memberDisplayName = message.member.displayName;
  if (message.reference?.messageId !== undefined) {
    gatewayMessage.replyToMessageId = message.reference.messageId;
  }
  if (message.mentions.repliedUser !== null && message.mentions.repliedUser !== undefined) {
    gatewayMessage.replyToUser = gatewayUser(message.mentions.repliedUser);
  }
  return gatewayMessage;
}

function gatewayEditedMessageFromDiscord(
  message: Message,
  client: Client,
): DiscordGatewayMessageEdited | undefined {
  const source = gatewayMessageFromDiscord(message, client);
  if (source === undefined) return undefined;
  const { type: _type, id: messageId, mentionedBot: _mentionedBot, ...rest } = source;
  return {
    ...rest,
    type: "message-edited",
    id: `${messageId}:edited:${message.editedTimestamp ?? Date.now()}`,
    messageId,
  };
}

function gatewayDeletedMessageFromDiscord(
  message: ClientEvents[Events.MessageDelete][0],
  client: Client,
): DiscordGatewayMessageDeleted | undefined {
  const bot = client.user;
  if (bot === null) return undefined;
  const thread = message.channel.isThread();
  const parentChannelId = message.channel.isThread() ? message.channel.parentId : null;
  const deleted: Mutable<DiscordGatewayMessageDeleted> = {
    type: "message-deleted",
    id: `${message.id}:deleted`,
    channelId: message.channelId,
    messageId: message.id,
    bot: gatewayUser(bot),
    direct: message.channel.isDMBased(),
    thread,
  };
  if (message.guildId !== null) deleted.guildId = message.guildId;
  if (parentChannelId !== null) deleted.parentChannelId = parentChannelId;
  return deleted;
}

function gatewayReactionFromDiscord(
  reaction: MessageReaction,
  user: User,
  client: Client,
  removed: boolean,
): DiscordGatewayReaction | undefined {
  const bot = client.user;
  if (bot === null) return undefined;
  const message = reaction.message;
  const thread = message.channel.isThread();
  const identifier = reaction.emoji.identifier;
  const gatewayReaction: Mutable<DiscordGatewayReaction> = {
    type: "reaction",
    id: `${message.id}:reaction:${user.id}:${identifier}:${removed ? "removed" : "added"}`,
    channelId: message.channelId,
    messageId: message.id,
    reaction: identifier,
    removed,
    user: gatewayUser(user),
    bot: gatewayUser(bot),
    direct: message.channel.isDMBased(),
    thread,
  };
  if (message.guildId !== null) gatewayReaction.guildId = message.guildId;
  if (thread && message.channel.parentId !== null) {
    gatewayReaction.parentChannelId = message.channel.parentId;
  }
  return gatewayReaction;
}

function gatewayActionFromDiscord(
  interaction: ButtonInteraction,
  client: Client,
): DiscordGatewayAction | undefined {
  const bot = client.user;
  const channel = interaction.channel;
  if (bot === null || channel === null) return undefined;
  const thread = channel.isThread();
  const action: Mutable<DiscordGatewayAction> = {
    type: "action",
    id: interaction.id,
    channelId: interaction.channelId,
    messageId: interaction.message.id,
    actionId: interaction.customId,
    user: gatewayUser(interaction.user),
    bot: gatewayUser(bot),
    direct: channel.isDMBased(),
    thread,
  };
  if (interaction.guildId !== null) action.guildId = interaction.guildId;
  if (thread && channel.parentId !== null) action.parentChannelId = channel.parentId;
  return action;
}

function gatewayUser(user: Message["author"]): DiscordGatewayUser {
  const gateway: Mutable<DiscordGatewayUser> = {
    id: user.id,
    username: user.username,
    bot: user.bot,
  };
  if (user.globalName !== null) gateway.globalName = user.globalName;
  return gateway;
}

function messageBody(
  message: Parameters<DiscordGateway["send"]>[1],
): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    content: message.text,
    allowed_mentions: { parse: [] },
    components: [],
  };
  if (message.replyToMessageId !== undefined) {
    body.message_reference = { message_id: message.replyToMessageId };
  }
  if (message.actions !== undefined) {
    body.components = [
      {
        type: 1,
        components: message.actions.map((action) => ({
          type: 2,
          style: action.style === "primary" ? 1 : action.style === "danger" ? 4 : 2,
          label: action.label,
          custom_id: action.id,
        })),
      },
    ];
  }
  return body;
}

async function discordFiles(
  message: Parameters<DiscordGateway["send"]>[1],
  fetchImplementation: typeof globalThis.fetch,
  maximumBytes: number,
): Promise<{ data: Buffer; name: string }[]> {
  if (message.attachments === undefined) return [];
  const files: { data: Buffer; name: string }[] = [];
  let totalBytes = 0;
  for (const [index, attachment] of message.attachments.entries()) {
    if (attachment.size !== undefined && attachment.size > maximumBytes) {
      throw new RangeError(`Discord attachment must not exceed ${maximumBytes} bytes`);
    }
    const data =
      attachment.source.type === "data"
        ? boundedBase64(attachment.source.data, maximumBytes)
        : await downloadAttachment(attachment.source.url, fetchImplementation, maximumBytes);
    totalBytes += data.byteLength;
    if (totalBytes > maximumBytes) {
      throw new RangeError(`Discord attachments must not exceed ${maximumBytes} bytes in total`);
    }
    files.push({ data, name: attachment.filename ?? `attachment-${index + 1}` });
  }
  return files;
}

function boundedBase64(data: string, maximumBytes: number): Buffer {
  const buffer = Buffer.from(data, "base64");
  if (buffer.byteLength > maximumBytes) {
    throw new RangeError(`Discord attachment must not exceed ${maximumBytes} bytes`);
  }
  return buffer;
}

async function downloadAttachment(
  url: string,
  fetchImplementation: typeof globalThis.fetch,
  maximumBytes: number,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImplementation(url, { redirect: "error" });
  } catch {
    // Fetch errors may contain a signed attachment URL.
    throw new Error("Discord attachment download failed");
  }
  if (!response.ok)
    throw new Error(`Discord attachment download failed with HTTP ${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maximumBytes
  ) {
    throw new RangeError(`Discord attachment must not exceed ${maximumBytes} bytes`);
  }
  if (response.body === null) return Buffer.alloc(0);
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
        // Preserve the size violation if stream cancellation fails.
      }
      throw new RangeError(`Discord attachment must not exceed ${maximumBytes} bytes`);
    }
    chunks.push(value);
    totalBytes += value.byteLength;
  }
  return Buffer.concat(chunks, totalBytes);
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
