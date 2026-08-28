import type { ChannelConversationKind, ChannelMessageEvent } from "@anvia/channel";
import { isSlackId, isSlackTimestamp } from "./identifiers.js";
import type { SlackSocketMessage } from "./types.js";

export function normalizeSlackMessage(
  message: SlackSocketMessage,
): ChannelMessageEvent<SlackSocketMessage> | undefined {
  if (!validSlackMessage(message) || (message.text.length === 0 && message.files.length === 0)) {
    return undefined;
  }

  return {
    type: "message",
    id: message.eventId,
    platform: "slack",
    accountId: message.teamId,
    conversation: {
      id: message.channelId,
      kind: conversationKind(message.channelType),
      ...(message.threadTimestamp === undefined ? {} : { threadId: message.threadTimestamp }),
    },
    sender: {
      id: message.senderId,
      ...(message.senderDisplayName === undefined
        ? {}
        : { displayName: message.senderDisplayName }),
      bot: message.senderBot,
    },
    text: message.text,
    attachments: message.files.map((file) => ({
      id: file.id,
      type: attachmentType(file.mediaType),
      mediaType: file.mediaType,
      filename: file.name,
      ...(file.size === undefined ? {} : { size: file.size }),
    })),
    mentionedBot:
      message.type === "app_mention" || message.text.includes(`<@${message.botUserId}>`),
    raw: message,
  };
}

function conversationKind(channelType: SlackSocketMessage["channelType"]): ChannelConversationKind {
  if (channelType === "im" || channelType === "app_home") return "direct";
  if (channelType === "mpim") return "group";
  return "channel";
}

function validSlackMessage(message: SlackSocketMessage): boolean {
  return (
    typeof message.eventId === "string" &&
    message.eventId.length > 0 &&
    (message.type === "message" || message.type === "app_mention") &&
    isSlackId(message.teamId) &&
    isSlackId(message.channelId) &&
    isSlackTimestamp(message.timestamp) &&
    (message.threadTimestamp === undefined || isSlackTimestamp(message.threadTimestamp)) &&
    isSlackId(message.senderId) &&
    (message.senderDisplayName === undefined || typeof message.senderDisplayName === "string") &&
    typeof message.senderBot === "boolean" &&
    typeof message.text === "string" &&
    Array.isArray(message.files) &&
    message.files.every(validFile) &&
    isSlackId(message.botUserId)
  );
}

function validFile(file: SlackSocketMessage["files"][number]): boolean {
  return (
    typeof file.id === "string" &&
    file.id.length > 0 &&
    typeof file.name === "string" &&
    file.name.length > 0 &&
    typeof file.mediaType === "string" &&
    file.mediaType.length > 0 &&
    (file.size === undefined || (Number.isSafeInteger(file.size) && file.size >= 0)) &&
    typeof file.privateDownloadUrl === "string"
  );
}

function attachmentType(mediaType: string): "image" | "audio" | "video" | "file" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return "file";
}
