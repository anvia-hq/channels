import { isRecord } from "@anvia/channel/adapter";
import type {
  TelegramCallbackQuery,
  TelegramChat,
  TelegramMediaFile,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramMessageReactionUpdated,
  TelegramPhotoSize,
  TelegramReactionType,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

export function parseTelegramUpdate(value: unknown, label = "Telegram update"): TelegramUpdate {
  const raw = object(value, label);
  const updateId = integer(raw.update_id, `${label}.update_id`);
  const result: {
    update_id: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
    message_reaction?: TelegramMessageReactionUpdated;
    callback_query?: TelegramCallbackQuery;
  } = {
    update_id: updateId,
  };

  if (raw.message !== undefined) {
    result.message = parseTelegramMessage(raw.message, `${label}.message`);
  }

  if (raw.edited_message !== undefined) {
    result.edited_message = parseTelegramMessage(raw.edited_message, `${label}.edited_message`);
  }

  if (raw.message_reaction !== undefined) {
    result.message_reaction = telegramMessageReaction(
      raw.message_reaction,
      `${label}.message_reaction`,
    );
  }

  if (raw.callback_query !== undefined) {
    result.callback_query = telegramCallbackQuery(raw.callback_query, `${label}.callback_query`);
  }

  return result;
}

export function rawUpdateId(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;

  const updateId: unknown = value.update_id;
  return typeof updateId === "number" && Number.isSafeInteger(updateId) ? updateId : undefined;
}

export function parseTelegramMessage(value: unknown, label: string): TelegramMessage {
  const raw = object(value, label);
  const result: {
    message_id: number;
    chat: TelegramChat;
    message_thread_id?: number;
    from?: TelegramUser;
    text?: string;
    entities?: readonly TelegramMessageEntity[];
    caption?: string;
    caption_entities?: readonly TelegramMessageEntity[];
    photo?: readonly TelegramPhotoSize[];
    document?: TelegramMediaFile;
    audio?: TelegramMediaFile;
    video?: TelegramMediaFile;
    voice?: TelegramMediaFile;
    reply_to_message?: TelegramMessage;
  } = {
    message_id: integer(raw.message_id, `${label}.message_id`),
    chat: telegramChat(raw.chat, `${label}.chat`),
  };

  const threadId = optionalInteger(raw.message_thread_id);

  if (threadId !== undefined) result.message_thread_id = threadId;

  if (raw.from !== undefined) result.from = parseTelegramUser(raw.from, `${label}.from`);

  const text = optionalString(raw.text);

  if (text !== undefined) result.text = text;

  if (raw.entities !== undefined) {
    result.entities = telegramEntities(raw.entities, `${label}.entities`);
  }

  const caption = optionalString(raw.caption);

  if (caption !== undefined) result.caption = caption;

  if (raw.caption_entities !== undefined) {
    result.caption_entities = telegramEntities(raw.caption_entities, `${label}.caption_entities`);
  }

  if (raw.photo !== undefined) result.photo = telegramPhotos(raw.photo, `${label}.photo`);

  for (const key of ["document", "audio", "video", "voice"] as const) {
    if (raw[key] !== undefined) result[key] = telegramMediaFile(raw[key], `${label}.${key}`);
  }

  if (raw.reply_to_message !== undefined) {
    result.reply_to_message = parseTelegramMessage(
      raw.reply_to_message,
      `${label}.reply_to_message`,
    );
  }

  return result;
}

export function parseTelegramUser(value: unknown, label: string): TelegramUser {
  const raw = object(value, label);
  const result: {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
  } = {
    id: integer(raw.id, `${label}.id`),
    is_bot: boolean(raw.is_bot, `${label}.is_bot`),
    first_name: string(raw.first_name, `${label}.first_name`),
  };
  const lastName = optionalString(raw.last_name);

  if (lastName !== undefined) result.last_name = lastName;

  const username = optionalString(raw.username);

  if (username !== undefined) result.username = username;

  return result;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} was not an object`);
  }

  return value;
}

export function nonemptyString(value: unknown, label: string): string {
  const result = string(value, label);

  if (result.length === 0) throw new TypeError(`${label} was empty`);

  return result;
}

export function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : string(value, "Telegram field");
}

export function optionalInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : integer(value, "Telegram field");
}

export function optionalNonnegativeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonnegativeInteger(value, label);
}

function telegramMessageReaction(value: unknown, label: string): TelegramMessageReactionUpdated {
  const raw = object(value, label);
  const result: {
    chat: TelegramChat;
    message_id: number;
    user?: TelegramUser;
    actor_chat?: TelegramChat;
    date: number;
    old_reaction: readonly TelegramReactionType[];
    new_reaction: readonly TelegramReactionType[];
  } = {
    chat: telegramChat(raw.chat, `${label}.chat`),
    message_id: integer(raw.message_id, `${label}.message_id`),
    date: integer(raw.date, `${label}.date`),
    old_reaction: telegramReactions(raw.old_reaction, `${label}.old_reaction`),
    new_reaction: telegramReactions(raw.new_reaction, `${label}.new_reaction`),
  };

  if (raw.user !== undefined) result.user = parseTelegramUser(raw.user, `${label}.user`);

  if (raw.actor_chat !== undefined) {
    result.actor_chat = telegramChat(raw.actor_chat, `${label}.actor_chat`);
  }

  if (result.user === undefined && result.actor_chat === undefined) {
    throw new TypeError(`${label} did not include a user or actor_chat`);
  }

  return result;
}

function telegramReactions(value: unknown, label: string): readonly TelegramReactionType[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} was not an array`);

  return value.map((candidate, index) => {
    const reaction = object(candidate, `${label}[${index}]`);

    if (reaction.type === "emoji") {
      return { type: "emoji", emoji: nonemptyString(reaction.emoji, `${label}[${index}].emoji`) };
    }

    if (reaction.type === "custom_emoji") {
      return {
        type: "custom_emoji",
        custom_emoji_id: nonemptyString(
          reaction.custom_emoji_id,
          `${label}[${index}].custom_emoji_id`,
        ),
      };
    }

    if (reaction.type === "paid") return { type: "paid" };

    throw new TypeError(`${label}[${index}].type was not a supported reaction type`);
  });
}

function telegramCallbackQuery(value: unknown, label: string): TelegramCallbackQuery {
  const raw = object(value, label);
  const result: {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
  } = {
    id: nonemptyString(raw.id, `${label}.id`),
    from: parseTelegramUser(raw.from, `${label}.from`),
  };

  if (raw.message !== undefined) {
    result.message = parseTelegramMessage(raw.message, `${label}.message`);
  }

  const data = optionalString(raw.data);

  if (data !== undefined) result.data = data;

  return result;
}

function telegramPhotos(value: unknown, label: string): readonly TelegramPhotoSize[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} was not a non-empty array`);
  }

  return value.map((item, index) => {
    const raw = object(item, `${label}[${index}]`);
    const itemLabel = `${label}[${index}]`;
    const fileSize = optionalNonnegativeInteger(raw.file_size, `${itemLabel}.file_size`);
    const photo: {
      file_id: string;
      width: number;
      height: number;
      file_size?: number;
    } = {
      file_id: nonemptyString(raw.file_id, `${itemLabel}.file_id`),
      width: positiveInteger(raw.width, `${itemLabel}.width`),
      height: positiveInteger(raw.height, `${itemLabel}.height`),
    };

    if (fileSize !== undefined) photo.file_size = fileSize;

    return photo;
  });
}

function telegramMediaFile(value: unknown, label: string): TelegramMediaFile {
  const raw = object(value, label);
  const fileName = optionalString(raw.file_name);
  const mediaType = optionalString(raw.mime_type);
  const fileSize = optionalNonnegativeInteger(raw.file_size, `${label}.file_size`);
  const file: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  } = {
    file_id: nonemptyString(raw.file_id, `${label}.file_id`),
  };

  if (fileName !== undefined) file.file_name = fileName;

  if (mediaType !== undefined) file.mime_type = mediaType;

  if (fileSize !== undefined) file.file_size = fileSize;

  return file;
}

function telegramChat(value: unknown, label: string): TelegramChat {
  const raw = object(value, label);
  const type = raw.type;

  if (type !== "private" && type !== "group" && type !== "supergroup" && type !== "channel") {
    throw new TypeError(`${label}.type was not a supported chat type`);
  }

  const result: {
    id: number;
    type: TelegramChat["type"];
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
  } = {
    id: integer(raw.id, `${label}.id`),
    type,
  };
  const title = optionalString(raw.title);

  if (title !== undefined) result.title = title;

  const username = optionalString(raw.username);

  if (username !== undefined) result.username = username;

  const firstName = optionalString(raw.first_name);

  if (firstName !== undefined) result.first_name = firstName;

  const lastName = optionalString(raw.last_name);

  if (lastName !== undefined) result.last_name = lastName;

  return result;
}

function telegramEntities(value: unknown, label: string): readonly TelegramMessageEntity[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} was not an array`);

  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    const raw = object(item, itemLabel);
    const result: {
      type: string;
      offset: number;
      length: number;
      user?: TelegramUser;
    } = {
      type: string(raw.type, `${itemLabel}.type`),
      offset: integer(raw.offset, `${itemLabel}.offset`),
      length: integer(raw.length, `${itemLabel}.length`),
    };

    if (raw.user !== undefined) result.user = parseTelegramUser(raw.user, `${itemLabel}.user`);

    return result;
  });
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} was not a string`);

  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} was not a Boolean`);

  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} was not a safe integer`);

  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const result = integer(value, label);

  if (result <= 0) throw new TypeError(`${label} was not a positive integer`);

  return result;
}

function nonnegativeInteger(value: unknown, label: string): number {
  const result = integer(value, label);

  if (result < 0) throw new TypeError(`${label} was not a nonnegative integer`);

  return result;
}
