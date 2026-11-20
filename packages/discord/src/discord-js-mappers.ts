import type { Mutable } from "@anvia/channel/adapter";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  Events,
  Message,
  MessageReaction,
  User,
} from "discord.js";
import { discordCommandOptionText } from "./normalize.js";
import type {
  DiscordGatewayAction,
  DiscordGatewayAttachment,
  DiscordGatewayCommand,
  DiscordGatewayMessage,
  DiscordGatewayMessageDeleted,
  DiscordGatewayMessageEdited,
  DiscordGatewayReaction,
  DiscordGatewayUser,
} from "./types.js";

export function gatewayMessageFromDiscord(
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

export function gatewayEditedMessageFromDiscord(
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

export function gatewayDeletedMessageFromDiscord(
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

export function gatewayReactionFromDiscord(
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

export function gatewayCommandFromDiscord(
  interaction: ChatInputCommandInteraction,
  client: Client,
): DiscordGatewayCommand | undefined {
  const bot = client.user;
  const channel = interaction.channel;

  if (bot === null || channel === null) return undefined;

  const thread = channel.isThread();
  const command: Mutable<DiscordGatewayCommand> = {
    type: "command",
    id: interaction.id,
    channelId: interaction.channelId,
    user: gatewayUser(interaction.user),
    bot: gatewayUser(bot),
    name: interaction.commandName,
    text: discordCommandOptionText(interaction.options.data),
    direct: channel.isDMBased(),
    thread,
  };

  if (interaction.guildId !== null) command.guildId = interaction.guildId;

  if (thread && channel.parentId !== null) command.parentChannelId = channel.parentId;

  return command;
}

export function gatewayActionFromDiscord(
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
