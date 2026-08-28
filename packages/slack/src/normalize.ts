import type {
  ChannelActionEvent,
  ChannelConversation,
  ChannelConversationKind,
  ChannelEvent,
  ChannelMessageEvent,
} from "@anvia/channel";
import { isChannelActionId } from "@anvia/channel";
import { isSlackId, isSlackTimestamp } from "./identifiers.js";
import type {
  SlackSocketAction,
  SlackSocketEvent,
  SlackSocketMessage,
  SlackSocketMessageDeleted,
  SlackSocketMessageEdited,
  SlackSocketReaction,
} from "./types.js";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export function normalizeSlackEvent(
  event: SlackSocketEvent,
): ChannelEvent<SlackSocketEvent> | undefined {
  if (event.type === "action") return normalizeSlackAction(event);
  if (event.type === "message-edited") return normalizeSlackEdit(event);
  if (event.type === "message-deleted") return normalizeSlackDelete(event);
  if (event.type === "reaction") return normalizeSlackReaction(event);
  return normalizeSlackMessage(event);
}

export function normalizeSlackMessage(
  message: SlackSocketMessage,
): ChannelMessageEvent<SlackSocketMessage> | undefined {
  if (!validSlackMessage(message) || (message.text.length === 0 && message.files.length === 0)) {
    return undefined;
  }

  const event: Mutable<ChannelMessageEvent<SlackSocketMessage>> = {
    type: "message",
    id: message.eventId,
    platform: "slack",
    accountId: message.teamId,
    conversation: conversation(
      message.channelId,
      conversationKind(message.channelType),
      message.threadTimestamp,
    ),
    sender: sender(message.senderId, message.senderBot, message.senderDisplayName),
    text: message.text,
    attachments: message.files.map(normalizedFile),
    mentionedBot:
      message.type === "app_mention" || message.text.includes(`<@${message.botUserId}>`),
    raw: message,
  };
  if (message.threadTimestamp !== undefined && message.threadTimestamp !== message.timestamp) {
    event.replyTo = { messageId: message.threadTimestamp };
  }
  return event;
}

function normalizeSlackEdit(
  event: SlackSocketMessageEdited,
): ChannelEvent<SlackSocketMessageEdited> | undefined {
  if (
    !validLifecycleBase(event) ||
    !isSlackId(event.senderId) ||
    typeof event.text !== "string" ||
    typeof event.senderBot !== "boolean" ||
    (event.senderDisplayName !== undefined && typeof event.senderDisplayName !== "string") ||
    !Array.isArray(event.files) ||
    !event.files.every(validFile)
  ) {
    return undefined;
  }
  return {
    type: "message-edited",
    id: event.eventId,
    platform: "slack",
    accountId: event.teamId,
    conversation: eventConversation(event),
    sender: sender(event.senderId, event.senderBot, event.senderDisplayName),
    messageId: event.messageTimestamp,
    text: event.text,
    attachments: event.files.map(normalizedFile),
    raw: event,
  };
}

function normalizeSlackDelete(
  event: SlackSocketMessageDeleted,
): ChannelEvent<SlackSocketMessageDeleted> | undefined {
  if (!validLifecycleBase(event)) return undefined;
  return {
    type: "message-deleted",
    id: event.eventId,
    platform: "slack",
    accountId: event.teamId,
    conversation: eventConversation(event),
    messageId: event.messageTimestamp,
    raw: event,
  };
}

function normalizeSlackReaction(
  event: SlackSocketReaction,
): ChannelEvent<SlackSocketReaction> | undefined {
  if (
    !validLifecycleBase(event) ||
    !isSlackId(event.senderId) ||
    typeof event.reaction !== "string" ||
    event.reaction.length === 0 ||
    typeof event.removed !== "boolean"
  ) {
    return undefined;
  }
  return {
    type: "reaction",
    id: event.eventId,
    platform: "slack",
    accountId: event.teamId,
    conversation: eventConversation(event),
    sender: { id: event.senderId, bot: event.senderId === event.botUserId },
    messageId: event.messageTimestamp,
    reaction: event.reaction,
    removed: event.removed,
    raw: event,
  };
}

function validLifecycleBase(
  event: SlackSocketMessageEdited | SlackSocketMessageDeleted | SlackSocketReaction,
): boolean {
  return (
    typeof event.eventId === "string" &&
    event.eventId.length > 0 &&
    isSlackId(event.teamId) &&
    isSlackId(event.channelId) &&
    ["channel", "group", "im", "mpim", "app_home"].includes(event.channelType) &&
    isSlackTimestamp(event.messageTimestamp) &&
    (event.threadTimestamp === undefined || isSlackTimestamp(event.threadTimestamp)) &&
    isSlackId(event.botUserId)
  );
}

function eventConversation(
  event: SlackSocketMessageEdited | SlackSocketMessageDeleted | SlackSocketReaction,
): ChannelConversation {
  return conversation(event.channelId, conversationKind(event.channelType), event.threadTimestamp);
}

function normalizedFile(file: SlackSocketMessage["files"][number]) {
  const attachment: {
    id: string;
    type: "image" | "audio" | "video" | "file";
    mediaType: string;
    filename: string;
    size?: number;
  } = {
    id: file.id,
    type: attachmentType(file.mediaType),
    mediaType: file.mediaType,
    filename: file.name,
  };
  if (file.size !== undefined) attachment.size = file.size;
  return attachment;
}

export function normalizeSlackAction(
  action: SlackSocketAction,
): ChannelActionEvent<SlackSocketAction> | undefined {
  if (!validSlackAction(action)) return undefined;
  return {
    type: "action",
    id: action.eventId,
    platform: "slack",
    accountId: action.teamId,
    conversation: conversation(
      action.channelId,
      conversationKind(action.channelType),
      action.threadTimestamp,
    ),
    sender: sender(action.senderId, false, action.senderDisplayName),
    messageId: action.messageTimestamp,
    actionId: action.actionId,
    raw: action,
  };
}

function conversation(
  id: string,
  kind: ChannelConversationKind,
  threadId?: string,
): ChannelConversation {
  if (threadId === undefined) return { id, kind };
  return { id, kind, threadId };
}

function sender(id: string, bot: boolean, displayName?: string) {
  if (displayName === undefined) return { id, bot };
  return { id, displayName, bot };
}

function validSlackAction(action: SlackSocketAction): boolean {
  return (
    action.type === "action" &&
    typeof action.eventId === "string" &&
    action.eventId.length > 0 &&
    isSlackId(action.teamId) &&
    isSlackId(action.channelId) &&
    ["channel", "group", "im", "mpim", "app_home"].includes(action.channelType) &&
    isSlackTimestamp(action.messageTimestamp) &&
    (action.threadTimestamp === undefined || isSlackTimestamp(action.threadTimestamp)) &&
    isSlackId(action.senderId) &&
    (action.senderDisplayName === undefined || typeof action.senderDisplayName === "string") &&
    isChannelActionId(action.actionId) &&
    isSlackTimestamp(action.actionTimestamp) &&
    isSlackId(action.botUserId)
  );
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
