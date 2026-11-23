import { AsyncLocalStorage } from "node:async_hooks";
import { reportErrorSafely } from "@anvia/channel/adapter";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type ClientEvents,
  type Interaction,
  type Message,
} from "discord.js";
import {
  gatewayActionFromDiscord,
  gatewayCommandFromDiscord,
  gatewayDeletedMessageFromDiscord,
  gatewayEditedMessageFromDiscord,
  gatewayMessageFromDiscord,
  gatewayReactionFromDiscord,
} from "./discord-js-mappers.js";
import { discordFiles, interactionReplyPayload, messageBody, sentMessage } from "./discord-rest.js";
import type { DiscordRestClient, RestRequest } from "./discord-rest.js";
import type {
  DiscordGateway,
  DiscordGatewayEvent,
  DiscordGatewayHandler,
  DiscordGatewaySentMessage,
} from "./types.js";

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type CommandReply = {
  interaction: ChatInputCommandInteraction;
  client: Client;
  active: boolean;
  state: "pending" | "sending" | "replied" | "fallback";
  inFlight?: Promise<DiscordGatewaySentMessage | undefined>;
};

type GatewaySession = Readonly<{
  client: Client;
  detach(): void;
}>;

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
  private session: GatewaySession | undefined;
  private readonly deliveries = new Set<Promise<void>>();
  private readonly commandReply = new AsyncLocalStorage<CommandReply>();

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

    if (typeof this.fetch !== "function") {
      throw new TypeError("A Fetch API implementation is required");
    }

    if (!Number.isSafeInteger(this.maximumAttachmentBytes) || this.maximumAttachmentBytes <= 0) {
      throw new TypeError("Discord maximum attachment size must be a positive integer");
    }
  }

  async start(handler: DiscordGatewayHandler): Promise<void> {
    if (this.session !== undefined) throw new Error("Discord gateway is already running");

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

    const session = this.attachListeners(client, handler);
    this.session = session;

    try {
      await client.login(this.token);

      if (client.user === null) throw new Error("Discord gateway started without a bot user");
    } catch (error) {
      this.teardownSession(session);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const session = this.session;

    if (session === undefined) return;

    this.teardownSession(session);
    await Promise.all(this.deliveries);
  }

  async send(
    channelId: string,
    message: Parameters<DiscordGateway["send"]>[1],
  ): Promise<DiscordGatewaySentMessage> {
    const reply = this.commandReply.getStore();
    const replyChannel = reply !== undefined && reply.interaction.channelId === channelId;

    if (replyChannel) {
      this.assertCommandReplyUsable(reply);
      const sent = await this.sendThroughInteraction(reply, channelId, message);

      if (sent !== undefined) return sent;
    }

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

  private async sendThroughInteraction(
    reply: CommandReply,
    channelId: string,
    message: Parameters<DiscordGateway["send"]>[1],
  ): Promise<DiscordGatewaySentMessage | undefined> {
    const files = await discordFiles(message, this.fetch, this.maximumAttachmentBytes);

    if (reply.state === "sending" && reply.inFlight !== undefined) {
      await reply.inFlight.catch(() => undefined);
    }

    this.assertCommandReplyUsable(reply);

    if (reply.state !== "pending") return undefined;

    reply.state = "sending";
    const attempt: Promise<DiscordGatewaySentMessage | undefined> = (async () => {
      try {
        const edited = await reply.interaction.editReply({
          ...interactionReplyPayload(message),
          files: files.map((file) => ({ attachment: file.data, name: file.name })),
        });

        if (edited === null) throw new Error("Discord command reply response is invalid");

        reply.state = "replied";
        return { id: edited.id, channelId };
      } catch (error) {
        reply.state = "fallback";
        await this.reportError(error);
        return undefined;
      }
    })();
    reply.inFlight = attempt;
    return attempt;
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
      body: { ...messageBody(message), attachments: [] },
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

  async unreact(channelId: string, messageId: string, reaction: string): Promise<void> {
    await this.rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, reaction));
  }

  private assertCommandReplyUsable(reply: CommandReply): void {
    if (!reply.active || reply.client !== this.session?.client) {
      throw new Error("Discord command handler is no longer active");
    }
  }

  private attachListeners(client: Client, handler: DiscordGatewayHandler): GatewaySession {
    const cleanups: (() => void)[] = [];
    const on = <Event extends keyof ClientEvents>(
      event: Event,
      listener: (...args: ClientEvents[Event]) => void,
    ): void => {
      client.on(event, listener);
      cleanups.push(() => client.off(event, listener));
    };

    const track = (task: () => Promise<void>): void => {
      const delivery: Promise<void> = Promise.resolve()
        .then(task)
        .catch((error: unknown) => this.reportError(error))
        .finally(() => this.deliveries.delete(delivery));
      this.deliveries.add(delivery);
    };

    const deliver = (
      createEvent: () => DiscordGatewayEvent | undefined | Promise<DiscordGatewayEvent | undefined>,
    ): void => {
      track(async () => {
        const event = await createEvent();

        if (event !== undefined) await handler(event);
      });
    };

    cleanups.push(...this.attachHealthListeners(client));
    on(Events.Error, (error: Error) => {
      void this.reportError(error);
    });
    on(Events.MessageCreate, (message: Message) => {
      deliver(() => gatewayMessageFromDiscord(message, client));
    });
    on(Events.InteractionCreate, (interaction: Interaction) => {
      track(() => this.handleInteraction(interaction, client, handler));
    });
    on(Events.MessageUpdate, (_oldMessage, newMessage) => {
      deliver(() => gatewayEditedMessageFromDiscord(newMessage, client));
    });
    on(Events.MessageDelete, (message) => {
      deliver(() => gatewayDeletedMessageFromDiscord(message, client));
    });
    on(Events.MessageReactionAdd, (reaction, user) => {
      deliver(async () => {
        const completeReaction = reaction.partial ? await reaction.fetch() : reaction;
        const completeUser = user.partial ? await client.users.fetch(user.id) : user;
        return gatewayReactionFromDiscord(completeReaction, completeUser, client, false);
      });
    });
    on(Events.MessageReactionRemove, (reaction, user) => {
      deliver(async () => {
        const completeReaction = reaction.partial ? await reaction.fetch() : reaction;
        const completeUser = user.partial ? await client.users.fetch(user.id) : user;
        return gatewayReactionFromDiscord(completeReaction, completeUser, client, true);
      });
    });

    return {
      client,
      detach() {
        for (const cleanup of cleanups) cleanup();
        client.destroy();
      },
    };
  }

  private async handleInteraction(
    interaction: Interaction,
    client: Client,
    handler: DiscordGatewayHandler,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      const command = gatewayCommandFromDiscord(interaction, client);

      if (command === undefined) {
        await this.rejectInteraction(interaction, "Discord command interaction could not be read");
        return;
      }

      if (!(await this.acknowledgeInteraction(() => interaction.deferReply()))) return;

      const reply: CommandReply = { interaction, client, active: true, state: "pending" };
      try {
        await this.commandReply.run(reply, () => handler(command));
      } finally {
        reply.active = false;

        await reply.inFlight?.catch(() => undefined);

        if (reply.state === "pending" || reply.state === "fallback") {
          try {
            await interaction.deleteReply();
          } catch (error) {
            await this.reportError(error);
          }
        }
      }
      return;
    }

    if (interaction.isButton()) {
      const action = gatewayActionFromDiscord(interaction, client);

      if (action === undefined) {
        await this.rejectInteraction(interaction, "Discord button interaction could not be read");
        return;
      }

      if (!(await this.acknowledgeInteraction(() => interaction.deferUpdate()))) return;

      await handler(action);
      return;
    }

    if (interaction.isAutocomplete()) {
      await this.reportError(new TypeError("Discord autocomplete interactions are not supported"));
      await this.acknowledgeInteraction(() => interaction.respond([]));
      return;
    }

    await this.rejectInteraction(
      interaction,
      `Discord interaction type ${interaction.type} is not supported`,
    );
  }

  private async acknowledgeInteraction(acknowledge: () => Promise<unknown>): Promise<boolean> {
    try {
      await acknowledge();
      return true;
    } catch (error) {
      await this.reportError(error);
      return false;
    }
  }

  private async rejectInteraction(interaction: Interaction, description: string): Promise<void> {
    await this.reportError(new TypeError(description));

    if (!interaction.isRepliable()) return;

    try {
      await interaction.reply({
        content: "This bot cannot handle this interaction.",
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await this.reportError(error);
    }
  }

  private teardownSession(session: GatewaySession): void {
    session.detach();

    if (this.session === session) this.session = undefined;
  }

  private attachHealthListeners(client: Client): (() => void)[] {
    const onDisconnect = () => {
      void this.reportError(new Error("Discord shard disconnected"));
    };
    const onReconnecting = () => {
      void this.reportError(new Error("Discord shard reconnecting"));
    };
    const onInvalidated = () => {
      void this.reportError(new Error("Discord session invalidated; check the bot token"));
    };
    client.on(Events.ShardDisconnect, onDisconnect);
    client.on(Events.ShardReconnecting, onReconnecting);
    client.on(Events.Invalidated, onInvalidated);
    return [
      () => client.off(Events.ShardDisconnect, onDisconnect),
      () => client.off(Events.ShardReconnecting, onReconnecting),
      () => client.off(Events.Invalidated, onInvalidated),
    ];
  }

  private reportError(error: unknown): Promise<void> {
    return reportErrorSafely(this.onError, error);
  }
}
