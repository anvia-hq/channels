import type { ChannelConversationKind, ChannelMessageEvent } from "@anvia/channel";
import { isSlackId, isSlackTimestamp } from "./identifiers.js";
import type { SlackSocketMessage } from "./types.js";

export function normalizeSlackMessage(
  message: SlackSocketMessage,
): ChannelMessageEvent<SlackSocketMessage> | undefined {
  if (!validSlackMessage(message) || message.text.length === 0) return undefined;

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
    isSlackId(message.botUserId)
  );
}
