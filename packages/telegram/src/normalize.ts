import type { ChannelConversationKind, ChannelMessageEvent } from "@anvia/channel";
import type {
  TelegramChatType,
  TelegramMessageEntity,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

export function normalizeTelegramUpdate(
  update: TelegramUpdate,
  bot: TelegramUser,
): ChannelMessageEvent<TelegramUpdate> | undefined {
  const message = update.message;
  if (message === undefined || message.from === undefined) return undefined;
  const text = message.text ?? message.caption ?? "";
  const attachments = telegramAttachments(message);
  if (text.length === 0 && attachments.length === 0) return undefined;

  const threadId = message.message_thread_id;
  return {
    type: "message",
    id: String(update.update_id),
    platform: "telegram",
    accountId: String(bot.id),
    conversation: {
      id: String(message.chat.id),
      kind: conversationKind(message.chat.type),
      ...(threadId === undefined ? {} : { threadId: String(threadId) }),
    },
    sender: {
      id: String(message.from.id),
      displayName: displayName(message.from),
      bot: message.from.is_bot,
    },
    text,
    attachments,
    mentionedBot:
      mentionsBot(text, message.entities ?? message.caption_entities ?? [], bot) ||
      message.reply_to_message?.from?.id === bot.id,
    raw: update,
  };
}

function telegramAttachments(
  message: NonNullable<TelegramUpdate["message"]>,
): ChannelMessageEvent["attachments"] {
  const attachments: Array<ChannelMessageEvent["attachments"][number]> = [];
  const photo = message.photo?.at(-1);
  if (photo !== undefined) {
    attachments.push({
      id: photo.file_id,
      type: "image",
      mediaType: "image/jpeg",
      ...(photo.file_size === undefined ? {} : { size: photo.file_size }),
    });
  }
  for (const [type, file] of [
    ["file", message.document],
    ["audio", message.audio],
    ["video", message.video],
    ["audio", message.voice],
  ] as const) {
    if (file === undefined) continue;
    const mediaType = file.mime_type ?? defaultMediaType(type);
    attachments.push({
      id: file.file_id,
      type: type === "file" && mediaType.startsWith("image/") ? "image" : type,
      mediaType,
      ...(file.file_name === undefined ? {} : { filename: file.file_name }),
      ...(file.file_size === undefined ? {} : { size: file.file_size }),
    });
  }
  return attachments;
}

function defaultMediaType(type: "file" | "audio" | "video"): string {
  if (type === "audio") return "audio/ogg";
  if (type === "video") return "video/mp4";
  return "application/octet-stream";
}

function conversationKind(type: TelegramChatType): ChannelConversationKind {
  if (type === "private") return "direct";
  if (type === "channel") return "channel";
  return "group";
}

function displayName(user: TelegramUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

function mentionsBot(
  text: string,
  entities: readonly TelegramMessageEntity[],
  bot: TelegramUser,
): boolean {
  return entities.some((entity) => {
    if (entity.type === "text_mention") return entity.user?.id === bot.id;
    if (entity.type !== "mention" && entity.type !== "bot_command") return false;
    if (bot.username === undefined) return false;
    const entityText = text.slice(entity.offset, entity.offset + entity.length);
    return entityText
      .toLocaleLowerCase("en-US")
      .endsWith(`@${bot.username.toLocaleLowerCase("en-US")}`);
  });
}
