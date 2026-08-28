import type {
  ChannelActionEvent,
  ChannelConversationKind,
  ChannelEvent,
  ChannelMessageEditedEvent,
  ChannelMessageEvent,
} from "@anvia/channel";
import { isChannelActionId } from "@anvia/channel";
import type {
  TelegramChat,
  TelegramChatType,
  TelegramMessageEntity,
  TelegramReactionType,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

export function normalizeTelegramUpdate(
  update: TelegramUpdate,
  bot: TelegramUser,
): readonly ChannelEvent<TelegramUpdate>[] {
  if (update.callback_query !== undefined) return eventArray(normalizeTelegramAction(update, bot));
  if (update.message_reaction !== undefined) return normalizeTelegramReaction(update, bot);
  if (update.edited_message !== undefined) return eventArray(normalizeTelegramEdit(update, bot));
  const message = update.message;
  if (message === undefined || message.from === undefined) return [];
  const text = message.text ?? message.caption ?? "";
  const attachments = telegramAttachments(message);
  if (text.length === 0 && attachments.length === 0) return [];

  const threadId = message.message_thread_id;
  return [
    {
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
      ...(message.reply_to_message === undefined
        ? {}
        : {
            replyTo: {
              messageId: String(message.reply_to_message.message_id),
              ...(message.reply_to_message.from === undefined
                ? {}
                : {
                    sender: {
                      id: String(message.reply_to_message.from.id),
                      displayName: displayName(message.reply_to_message.from),
                      bot: message.reply_to_message.from.is_bot,
                    },
                  }),
              ...((message.reply_to_message.text ?? message.reply_to_message.caption) === undefined
                ? {}
                : { text: message.reply_to_message.text ?? message.reply_to_message.caption }),
            },
          }),
      mentionedBot:
        mentionsBot(text, message.entities ?? message.caption_entities ?? [], bot) ||
        message.reply_to_message?.from?.id === bot.id,
      raw: update,
    },
  ];
}

function normalizeTelegramReaction(
  update: TelegramUpdate,
  bot: TelegramUser,
): readonly ChannelEvent<TelegramUpdate>[] {
  const source = update.message_reaction;
  if (source === undefined) return [];
  const sender = reactionSender(source.user, source.actor_chat);
  if (sender === undefined) return [];
  const oldReactions = new Map(
    source.old_reaction.map((reaction) => [reactionKey(reaction), reaction]),
  );
  const newReactions = new Map(
    source.new_reaction.map((reaction) => [reactionKey(reaction), reaction]),
  );
  const changes = [
    ...[...oldReactions].flatMap(([key, reaction]) =>
      newReactions.has(key) ? [] : [{ reaction, removed: true }],
    ),
    ...[...newReactions].flatMap(([key, reaction]) =>
      oldReactions.has(key) ? [] : [{ reaction, removed: false }],
    ),
  ];
  return changes.map(({ reaction, removed }, index) => ({
    type: "reaction",
    id: `${update.update_id}:reaction:${index + 1}`,
    platform: "telegram",
    accountId: String(bot.id),
    conversation: {
      id: String(source.chat.id),
      kind: conversationKind(source.chat.type),
    },
    sender,
    messageId: String(source.message_id),
    reaction: portableReaction(reaction),
    removed,
    raw: update,
  }));
}

function reactionKey(reaction: TelegramReactionType): string {
  if (reaction.type === "emoji") return `emoji:${reaction.emoji}`;
  if (reaction.type === "custom_emoji") return `custom_emoji:${reaction.custom_emoji_id}`;
  return "paid";
}

function portableReaction(reaction: TelegramReactionType): string {
  if (reaction.type === "emoji") return reaction.emoji;
  if (reaction.type === "custom_emoji") return `telegram:custom_emoji:${reaction.custom_emoji_id}`;
  return "telegram:paid";
}

function reactionSender(user: TelegramUser | undefined, actorChat: TelegramChat | undefined) {
  if (user !== undefined) {
    return { id: String(user.id), displayName: displayName(user), bot: user.is_bot } as const;
  }
  if (actorChat === undefined) return undefined;
  const actorDisplayName =
    actorChat.title ??
    actorChat.username ??
    [actorChat.first_name, actorChat.last_name].filter(Boolean).join(" ");
  return {
    id: String(actorChat.id),
    ...(actorDisplayName.length === 0 ? {} : { displayName: actorDisplayName }),
    bot: false,
  } as const;
}

function eventArray<RawEvent>(
  event: ChannelEvent<RawEvent> | undefined,
): readonly ChannelEvent<RawEvent>[] {
  return event === undefined ? [] : [event];
}

function normalizeTelegramEdit(
  update: TelegramUpdate,
  bot: TelegramUser,
): ChannelMessageEditedEvent<TelegramUpdate> | undefined {
  const message = update.edited_message;
  if (message?.from === undefined) return undefined;
  const text = message.text ?? message.caption ?? "";
  const attachments = telegramAttachments(message);
  if (text.length === 0 && attachments.length === 0) return undefined;
  return {
    type: "message-edited",
    id: String(update.update_id),
    platform: "telegram",
    accountId: String(bot.id),
    conversation: {
      id: String(message.chat.id),
      kind: conversationKind(message.chat.type),
      ...(message.message_thread_id === undefined
        ? {}
        : { threadId: String(message.message_thread_id) }),
    },
    sender: {
      id: String(message.from.id),
      displayName: displayName(message.from),
      bot: message.from.is_bot,
    },
    messageId: String(message.message_id),
    text,
    attachments,
    raw: update,
  };
}

function normalizeTelegramAction(
  update: TelegramUpdate,
  bot: TelegramUser,
): ChannelActionEvent<TelegramUpdate> | undefined {
  const query = update.callback_query;
  const message = query?.message;
  if (query === undefined || message === undefined || !isChannelActionId(query.data)) {
    return undefined;
  }
  return {
    type: "action",
    id: String(update.update_id),
    platform: "telegram",
    accountId: String(bot.id),
    conversation: {
      id: String(message.chat.id),
      kind: conversationKind(message.chat.type),
      ...(message.message_thread_id === undefined
        ? {}
        : { threadId: String(message.message_thread_id) }),
    },
    sender: {
      id: String(query.from.id),
      displayName: displayName(query.from),
      bot: query.from.is_bot,
    },
    messageId: String(message.message_id),
    actionId: query.data,
    raw: update,
  };
}

function telegramAttachments(
  message: NonNullable<TelegramUpdate["message"] | TelegramUpdate["edited_message"]>,
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
