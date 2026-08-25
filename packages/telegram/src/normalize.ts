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
  if (message?.text === undefined || message.from === undefined) return undefined;

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
    text: message.text,
    mentionedBot:
      mentionsBot(message.text, message.entities ?? [], bot) ||
      message.reply_to_message?.from?.id === bot.id,
    raw: update,
  };
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
