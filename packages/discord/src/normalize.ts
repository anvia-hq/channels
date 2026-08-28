import type { ChannelMessageEvent } from "@anvia/channel";
import { isDiscordSnowflake } from "./snowflake.js";
import type { DiscordGatewayMessage } from "./types.js";

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
    mentionedBot: message.mentionedBot,
    raw: message,
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
    typeof message.mentionedBot === "boolean"
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
