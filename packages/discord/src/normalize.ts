import type {
  ChannelActionEvent,
  ChannelCommandEvent,
  ChannelConversation,
  ChannelEvent,
  ChannelMessageEvent,
} from "@anvia/channel";
import { isChannelActionId } from "@anvia/channel";
import { attachmentTypeFromMediaType } from "@anvia/channel/adapter";
import type { Mutable } from "@anvia/channel/adapter";
import { isDiscordSnowflake } from "./snowflake.js";
import type {
  DiscordCommandOption,
  DiscordGatewayAction,
  DiscordGatewayCommand,
  DiscordGatewayEvent,
  DiscordGatewayMessage,
  DiscordGatewayMessageDeleted,
  DiscordGatewayMessageEdited,
  DiscordGatewayReaction,
  DiscordGatewayUser,
} from "./types.js";

export function normalizeDiscordEvent(
  event: DiscordGatewayEvent,
): ChannelEvent<DiscordGatewayEvent> | undefined {
  if (event.type === "action") return normalizeDiscordAction(event);

  if (event.type === "command") return normalizeDiscordCommand(event);

  if (event.type === "message-edited") return normalizeDiscordEdit(event);

  if (event.type === "message-deleted") return normalizeDiscordDelete(event);

  if (event.type === "reaction") return normalizeDiscordReaction(event);

  return normalizeDiscordMessage(event);
}

export function discordCommandOptionText(options: readonly DiscordCommandOption[]): string {
  const parts: string[] = [];
  const collect = (entries: readonly DiscordCommandOption[]): void => {
    for (const option of entries) {
      const nested = option.options;

      if (nested !== undefined && nested.length > 0) {
        parts.push(option.name);
        collect(nested);
        continue;
      }

      if (option.value === undefined) continue;

      const value = typeof option.value === "string" ? option.value.trim() : String(option.value);

      if (value.length > 0) parts.push(value);
    }
  };
  collect(options);
  return parts.join(" ");
}

export function normalizeDiscordCommand(
  command: DiscordGatewayCommand,
): ChannelCommandEvent<DiscordGatewayEvent> | undefined {
  if (
    command.type !== "command" ||
    !isDiscordSnowflake(command.id) ||
    !isDiscordSnowflake(command.channelId) ||
    (command.guildId !== undefined && !isDiscordSnowflake(command.guildId)) ||
    (command.parentChannelId !== undefined && !isDiscordSnowflake(command.parentChannelId)) ||
    !validUser(command.user) ||
    !validUser(command.bot) ||
    typeof command.name !== "string" ||
    command.name.length === 0 ||
    typeof command.text !== "string" ||
    typeof command.direct !== "boolean" ||
    typeof command.thread !== "boolean"
  ) {
    return undefined;
  }

  return {
    type: "command",
    id: command.id,
    platform: "discord",
    accountId: command.bot.id,
    conversation: resolveConversation(command),
    sender: senderFromUser(command.user),
    name: command.name,
    text: command.text,
    raw: command,
  };
}

export function normalizeDiscordMessage(
  message: DiscordGatewayMessage,
): ChannelMessageEvent<DiscordGatewayMessage> | undefined {
  if (
    !validDiscordMessage(message) ||
    message.system ||
    (message.content.length === 0 && message.attachments.length === 0)
  ) {
    return undefined;
  }

  const event: Mutable<ChannelMessageEvent<DiscordGatewayMessage>> = {
    type: "message",
    id: message.id,
    platform: "discord",
    accountId: message.bot.id,
    conversation: resolveConversation(message),
    sender: senderFromUser(message.author, message.memberDisplayName),
    text: message.content,
    attachments: message.attachments.map(normalizedAttachment),
    mentionedBot: message.mentionedBot,
    raw: message,
  };

  if (message.replyToMessageId !== undefined) {
    if (message.replyToUser === undefined) {
      event.replyTo = { messageId: message.replyToMessageId };
    } else {
      event.replyTo = {
        messageId: message.replyToMessageId,
        sender: senderFromUser(message.replyToUser),
      };
    }
  }

  return event;
}

export function normalizeDiscordAction(
  action: DiscordGatewayAction,
): ChannelActionEvent<DiscordGatewayAction> | undefined {
  if (
    !isDiscordSnowflake(action.id) ||
    !isDiscordSnowflake(action.channelId) ||
    (action.guildId !== undefined && !isDiscordSnowflake(action.guildId)) ||
    (action.parentChannelId !== undefined && !isDiscordSnowflake(action.parentChannelId)) ||
    !isDiscordSnowflake(action.messageId) ||
    !isChannelActionId(action.actionId) ||
    !validUser(action.user) ||
    !validUser(action.bot) ||
    typeof action.direct !== "boolean" ||
    typeof action.thread !== "boolean"
  ) {
    return undefined;
  }

  return {
    type: "action",
    id: action.id,
    platform: "discord",
    accountId: action.bot.id,
    conversation: resolveConversation(action),
    sender: senderFromUser(action.user),
    messageId: action.messageId,
    actionId: action.actionId,
    raw: action,
  };
}

function normalizeDiscordEdit(
  event: DiscordGatewayMessageEdited,
): ChannelEvent<DiscordGatewayMessageEdited> | undefined {
  if (!validEditedMessage(event) || event.system) return undefined;

  return {
    type: "message-edited",
    id: event.id,
    platform: "discord",
    accountId: event.bot.id,
    conversation: resolveConversation(event),
    sender: senderFromUser(event.author, event.memberDisplayName),
    messageId: event.messageId,
    text: event.content,
    attachments: event.attachments.map(normalizedAttachment),
    raw: event,
  };
}

function normalizeDiscordDelete(
  event: DiscordGatewayMessageDeleted,
): ChannelEvent<DiscordGatewayMessageDeleted> | undefined {
  if (!validLifecycleBase(event)) return undefined;

  return {
    type: "message-deleted",
    id: event.id,
    platform: "discord",
    accountId: event.bot.id,
    conversation: resolveConversation(event),
    messageId: event.messageId,
    raw: event,
  };
}

function normalizeDiscordReaction(
  event: DiscordGatewayReaction,
): ChannelEvent<DiscordGatewayReaction> | undefined {
  if (
    !validLifecycleBase(event) ||
    !validUser(event.user) ||
    typeof event.reaction !== "string" ||
    event.reaction.length === 0 ||
    typeof event.removed !== "boolean"
  ) {
    return undefined;
  }

  return {
    type: "reaction",
    id: event.id,
    platform: "discord",
    accountId: event.bot.id,
    conversation: resolveConversation(event),
    sender: senderFromUser(event.user),
    messageId: event.messageId,
    reaction: event.reaction,
    removed: event.removed,
    raw: event,
  };
}

function resolveConversation(
  event: Readonly<{
    channelId: string;
    parentChannelId?: string;
    direct: boolean;
    thread: boolean;
  }>,
): ChannelConversation {
  const threadId = event.thread ? event.channelId : undefined;
  const id = event.thread ? (event.parentChannelId ?? event.channelId) : event.channelId;
  const kind = event.direct ? "direct" : "channel";
  return threadId === undefined ? { id, kind } : { id, kind, threadId };
}

function senderFromUser(user: DiscordGatewayUser, memberDisplayName?: string) {
  return {
    id: user.id,
    displayName: memberDisplayName ?? user.globalName ?? user.username,
    bot: user.bot,
  } as const;
}

function normalizedAttachment(attachment: DiscordGatewayMessage["attachments"][number]) {
  const mediaType = attachment.mediaType ?? mediaTypeFromFilename(attachment.filename);
  return {
    id: attachment.id,
    type: attachmentTypeFromMediaType(mediaType),
    mediaType,
    filename: attachment.filename,
    size: attachment.size,
  } as const;
}

function validEditedMessage(event: DiscordGatewayMessageEdited): boolean {
  return (
    validLifecycleBase(event) &&
    validUser(event.author) &&
    typeof event.content === "string" &&
    Array.isArray(event.attachments) &&
    event.attachments.every(validAttachment) &&
    (event.memberDisplayName === undefined || typeof event.memberDisplayName === "string") &&
    typeof event.system === "boolean"
  );
}

function validLifecycleBase(
  event: DiscordGatewayMessageEdited | DiscordGatewayMessageDeleted | DiscordGatewayReaction,
): boolean {
  return (
    typeof event.id === "string" &&
    event.id.length > 0 &&
    isDiscordSnowflake(event.channelId) &&
    isDiscordSnowflake(event.messageId) &&
    (event.guildId === undefined || isDiscordSnowflake(event.guildId)) &&
    (event.parentChannelId === undefined || isDiscordSnowflake(event.parentChannelId)) &&
    validUser(event.bot) &&
    typeof event.direct === "boolean" &&
    typeof event.thread === "boolean"
  );
}

function validDiscordMessage(message: DiscordGatewayMessage): boolean {
  return (
    isDiscordSnowflake(message.id) &&
    isDiscordSnowflake(message.channelId) &&
    (message.guildId === undefined || isDiscordSnowflake(message.guildId)) &&
    (message.parentChannelId === undefined || isDiscordSnowflake(message.parentChannelId)) &&
    validUser(message.author) &&
    validUser(message.bot) &&
    typeof message.content === "string" &&
    Array.isArray(message.attachments) &&
    message.attachments.every(validAttachment) &&
    typeof message.direct === "boolean" &&
    typeof message.thread === "boolean" &&
    typeof message.system === "boolean" &&
    typeof message.mentionedBot === "boolean" &&
    (message.replyToMessageId === undefined || isDiscordSnowflake(message.replyToMessageId)) &&
    (message.replyToUser === undefined || validUser(message.replyToUser))
  );
}

function validAttachment(attachment: DiscordGatewayMessage["attachments"][number]): boolean {
  if (
    !isDiscordSnowflake(attachment.id) ||
    typeof attachment.url !== "string" ||
    typeof attachment.filename !== "string" ||
    attachment.filename.length === 0 ||
    !Number.isSafeInteger(attachment.size) ||
    attachment.size < 0 ||
    (attachment.mediaType !== undefined &&
      (typeof attachment.mediaType !== "string" || attachment.mediaType.length === 0))
  ) {
    return false;
  }

  try {
    const url = new URL(attachment.url);
    return (
      url.protocol === "https:" &&
      (url.hostname === "cdn.discordapp.com" || url.hostname === "media.discordapp.net")
    );
  } catch {
    return false;
  }
}

function mediaTypeFromFilename(filename: string): string {
  const extension = filename.split(".").at(-1)?.toLocaleLowerCase("en-US");

  if (["jpg", "jpeg"].includes(extension ?? "")) return "image/jpeg";

  if (extension === "png") return "image/png";

  if (extension === "gif") return "image/gif";

  if (extension === "webp") return "image/webp";

  if (extension === "pdf") return "application/pdf";

  return "application/octet-stream";
}

function validUser(user: unknown): user is DiscordGatewayUser {
  if (typeof user !== "object" || user === null) return false;

  const candidate = user as Partial<DiscordGatewayUser>;
  return (
    isDiscordSnowflake(candidate.id) &&
    typeof candidate.username === "string" &&
    candidate.username.length > 0 &&
    (candidate.globalName === undefined || typeof candidate.globalName === "string") &&
    typeof candidate.bot === "boolean"
  );
}
