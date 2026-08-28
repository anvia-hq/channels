import type { ChannelActionEvent, ChannelEvent, ChannelMessageEvent } from "@anvia/channel";
import { isChannelActionId } from "@anvia/channel";
import { isDiscordSnowflake } from "./snowflake.js";
import type {
  DiscordGatewayAction,
  DiscordGatewayEvent,
  DiscordGatewayMessage,
  DiscordGatewayMessageDeleted,
  DiscordGatewayMessageEdited,
  DiscordGatewayReaction,
} from "./types.js";

export function normalizeDiscordEvent(
  event: DiscordGatewayEvent,
): ChannelEvent<DiscordGatewayEvent> | undefined {
  if (event.type === "action") return normalizeDiscordAction(event);
  if (event.type === "message-edited") return normalizeDiscordEdit(event);
  if (event.type === "message-deleted") return normalizeDiscordDelete(event);
  if (event.type === "reaction") return normalizeDiscordReaction(event);
  return normalizeDiscordMessage(event);
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

  const threadId = message.thread ? message.channelId : undefined;
  const conversationId = message.thread
    ? (message.parentChannelId ?? message.channelId)
    : message.channelId;

  return {
    type: "message",
    id: message.id,
    platform: "discord",
    accountId: message.bot.id,
    conversation: {
      id: conversationId,
      kind: message.direct ? "direct" : "channel",
      ...(threadId === undefined ? {} : { threadId }),
    },
    sender: {
      id: message.author.id,
      displayName:
        message.memberDisplayName ?? message.author.globalName ?? message.author.username,
      bot: message.author.bot,
    },
    text: message.content,
    attachments: message.attachments.map((attachment) => {
      const mediaType = attachment.mediaType ?? mediaTypeFromFilename(attachment.filename);
      return {
        id: attachment.id,
        type: attachmentType(mediaType),
        mediaType,
        filename: attachment.filename,
        size: attachment.size,
      };
    }),
    ...(message.replyToMessageId === undefined
      ? {}
      : {
          replyTo: {
            messageId: message.replyToMessageId,
            ...(message.replyToUser === undefined
              ? {}
              : {
                  sender: {
                    id: message.replyToUser.id,
                    displayName: message.replyToUser.globalName ?? message.replyToUser.username,
                    bot: message.replyToUser.bot,
                  },
                }),
          },
        }),
    mentionedBot: message.mentionedBot,
    raw: message,
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
    conversation: gatewayConversation(event),
    sender: {
      id: event.author.id,
      displayName: event.memberDisplayName ?? event.author.globalName ?? event.author.username,
      bot: event.author.bot,
    },
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
    conversation: gatewayConversation(event),
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
    conversation: gatewayConversation(event),
    sender: {
      id: event.user.id,
      displayName: event.user.globalName ?? event.user.username,
      bot: event.user.bot,
    },
    messageId: event.messageId,
    reaction: event.reaction,
    removed: event.removed,
    raw: event,
  };
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

function gatewayConversation(
  event: DiscordGatewayMessageEdited | DiscordGatewayMessageDeleted | DiscordGatewayReaction,
) {
  return {
    id: event.parentChannelId ?? event.channelId,
    kind: event.direct ? "direct" : "channel",
    ...(event.thread ? { threadId: event.channelId } : {}),
  } as const;
}

function normalizedAttachment(attachment: DiscordGatewayMessage["attachments"][number]) {
  const mediaType = attachment.mediaType ?? mediaTypeFromFilename(attachment.filename);
  return {
    id: attachment.id,
    type: attachmentType(mediaType),
    mediaType,
    filename: attachment.filename,
    size: attachment.size,
  } as const;
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
    conversation: {
      id: action.parentChannelId ?? action.channelId,
      kind: action.direct ? "direct" : "channel",
      ...(action.thread ? { threadId: action.channelId } : {}),
    },
    sender: {
      id: action.user.id,
      displayName: action.user.globalName ?? action.user.username,
      bot: action.user.bot,
    },
    messageId: action.messageId,
    actionId: action.actionId,
    raw: action,
  };
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

function attachmentType(mediaType: string | undefined): "image" | "audio" | "video" | "file" {
  if (mediaType?.startsWith("image/") === true) return "image";
  if (mediaType?.startsWith("audio/") === true) return "audio";
  if (mediaType?.startsWith("video/") === true) return "video";
  return "file";
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

function validUser(user: DiscordGatewayUserLike): boolean {
  return (
    isDiscordSnowflake(user.id) &&
    typeof user.username === "string" &&
    user.username.length > 0 &&
    (user.globalName === undefined || typeof user.globalName === "string") &&
    typeof user.bot === "boolean"
  );
}

type DiscordGatewayUserLike = DiscordGatewayMessage["author"];
