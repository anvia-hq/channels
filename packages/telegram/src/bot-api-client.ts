import type {
  TelegramBotApi,
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

const DEFAULT_BASE_URL = "https://api.telegram.org";
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type TelegramBotApiClientOptions = Readonly<{
  token: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  maximumAttachmentBytes?: number;
}>;

export class TelegramApiError extends Error {
  readonly method: string;
  readonly errorCode: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    method: string,
    description: string,
    options: {
      errorCode?: number;
      retryAfterSeconds?: number;
      cause?: unknown;
    } = {},
  ) {
    super(`Telegram ${method} failed: ${description}`, { cause: options.cause });
    this.name = "TelegramApiError";
    this.method = method;
    this.errorCode = options.errorCode;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function createTelegramBotApiClient(options: TelegramBotApiClientOptions): TelegramBotApi {
  const token = validateToken(options.token);
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const maximumAttachmentBytes = options.maximumAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  if (!Number.isSafeInteger(maximumAttachmentBytes) || maximumAttachmentBytes <= 0) {
    throw new TypeError("Telegram maximum attachment size must be a positive integer");
  }

  if (typeof fetchImplementation !== "function") {
    throw new TypeError("A Fetch API implementation is required");
  }

  const request = async (
    method: string,
    body: string | FormData,
    contentType: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        ...(contentType === undefined ? {} : { headers: { "content-type": contentType } }),
        body,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      // Fetch errors can contain the request URL, which embeds the bot token.
      throw new TelegramApiError(method, "request failed");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new TelegramApiError(method, `received invalid JSON (HTTP ${response.status})`, {
        cause: error,
      });
    }

    const envelope = object(payload, "Telegram response");
    if (typeof envelope.ok !== "boolean") {
      throw new TelegramApiError(method, "response did not include a Boolean ok field");
    }
    if (!envelope.ok) {
      const errorCode = optionalInteger(envelope.error_code);
      const retryAfterSeconds = responseRetryAfter(envelope.parameters);
      throw new TelegramApiError(
        method,
        optionalString(envelope.description) ?? `HTTP ${response.status}`,
        {
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        },
      );
    }
    if (!("result" in envelope)) {
      throw new TelegramApiError(method, "response did not include a result");
    }
    return envelope.result;
  };
  const call = (method: string, body: object, signal?: AbortSignal) =>
    request(method, JSON.stringify(body), "application/json", signal);

  return {
    async getMe(signal) {
      return telegramUser(await call("getMe", {}, signal), "getMe result");
    },

    async getUpdates(request, signal) {
      const result = await call("getUpdates", request, signal);
      if (!Array.isArray(result)) {
        throw new TelegramApiError("getUpdates", "result was not an array");
      }
      return result.map((update, index) =>
        parseTelegramUpdate(update, `getUpdates result[${index}]`),
      );
    },

    async sendMessage(request, signal) {
      return telegramMessage(await call("sendMessage", request, signal), "sendMessage result");
    },

    async sendAttachment(sendRequest, signal) {
      if (
        sendRequest.attachment.size !== undefined &&
        sendRequest.attachment.size > maximumAttachmentBytes
      ) {
        throw new RangeError(`Telegram attachment must not exceed ${maximumAttachmentBytes} bytes`);
      }
      const method = attachmentMethod(sendRequest.attachment.type);
      const field = attachmentField(sendRequest.attachment.type);
      const common = {
        chat_id: sendRequest.chat_id,
        ...(sendRequest.message_thread_id === undefined
          ? {}
          : { message_thread_id: sendRequest.message_thread_id }),
        ...(sendRequest.caption === undefined ? {} : { caption: sendRequest.caption }),
        ...(sendRequest.reply_parameters === undefined
          ? {}
          : { reply_parameters: sendRequest.reply_parameters }),
        ...(sendRequest.reply_markup === undefined
          ? {}
          : { reply_markup: sendRequest.reply_markup }),
      };
      let result: unknown;
      if (sendRequest.attachment.source.type === "url") {
        result = await call(
          method,
          { ...common, [field]: sendRequest.attachment.source.url },
          signal,
        );
      } else {
        const bytes = Buffer.from(sendRequest.attachment.source.data, "base64");
        if (bytes.byteLength > maximumAttachmentBytes) {
          throw new RangeError(
            `Telegram attachment must not exceed ${maximumAttachmentBytes} bytes`,
          );
        }
        const form = new FormData();
        for (const [key, value] of Object.entries(common)) {
          form.set(key, typeof value === "string" ? value : JSON.stringify(value));
        }
        form.set(
          field,
          new Blob([bytes], { type: sendRequest.attachment.mediaType }),
          sendRequest.attachment.filename ?? "attachment",
        );
        result = await request(method, form, undefined, signal);
      }
      return telegramMessage(result, `${method} result`);
    },

    async editMessageText(request, signal) {
      const result = await call("editMessageText", request, signal);
      if (result === true) return true;
      return telegramMessage(result, "editMessageText result");
    },

    async answerCallbackQuery(request, signal) {
      const result = await call("answerCallbackQuery", request, signal);
      if (result !== true) {
        throw new TelegramApiError("answerCallbackQuery", "result was not true");
      }
      return true;
    },

    async deleteMessage(request, signal) {
      return trueResult("deleteMessage", await call("deleteMessage", request, signal));
    },

    async sendChatAction(request, signal) {
      return trueResult("sendChatAction", await call("sendChatAction", request, signal));
    },

    async setMessageReaction(request, signal) {
      return trueResult("setMessageReaction", await call("setMessageReaction", request, signal));
    },

    async downloadFile(fileId, signal) {
      if (typeof fileId !== "string" || fileId.length === 0) {
        throw new TypeError("Telegram file ID must not be empty");
      }
      const file = object(await call("getFile", { file_id: fileId }, signal), "getFile result");
      const filePath = nonemptyString(file.file_path, "getFile result.file_path");
      if (!validFilePath(filePath)) throw new TypeError("Telegram file path is invalid");
      const fileSize = optionalNonnegativeInteger(file.file_size, "getFile result.file_size");
      if (fileSize !== undefined && fileSize > maximumAttachmentBytes) {
        throw new RangeError(`Telegram attachment must not exceed ${maximumAttachmentBytes} bytes`);
      }

      let response: Response;
      try {
        response = await fetchImplementation(
          `${baseUrl}/file/bot${token}/${filePath}`,
          signal === undefined ? undefined : { signal },
        );
      } catch (error) {
        if (signal?.aborted === true) throw error;
        throw new TelegramApiError("downloadFile", "request failed");
      }
      if (!response.ok) {
        throw new TelegramApiError("downloadFile", `received HTTP ${response.status}`);
      }
      try {
        return {
          type: "data",
          data: await readResponseBase64(response, maximumAttachmentBytes),
        };
      } catch (error) {
        if (error instanceof RangeError || signal?.aborted === true) throw error;
        throw new TelegramApiError("downloadFile", "response body could not be read");
      }
    },
  };
}

function trueResult(method: string, value: unknown): true {
  if (value !== true) throw new TelegramApiError(method, "result was not true");
  return true;
}

function attachmentMethod(type: "image" | "audio" | "video" | "file"): string {
  if (type === "image") return "sendPhoto";
  if (type === "audio") return "sendAudio";
  if (type === "video") return "sendVideo";
  return "sendDocument";
}

function attachmentField(type: "image" | "audio" | "video" | "file"): string {
  if (type === "image") return "photo";
  if (type === "audio") return "audio";
  if (type === "video") return "video";
  return "document";
}

async function readResponseBase64(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (declaredBytes > maximumBytes) {
      throw new RangeError(`Telegram attachment must not exceed ${maximumBytes} bytes`);
    }
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (totalBytes + value.byteLength > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size violation is the useful error even if stream cancellation fails.
      }
      throw new RangeError(`Telegram attachment must not exceed ${maximumBytes} bytes`);
    }
    chunks.push(value);
    totalBytes += value.byteLength;
  }
  return Buffer.concat(chunks, totalBytes).toString("base64");
}

function validFilePath(value: string): boolean {
  return value.length > 0 && !value.includes("..") && /^[A-Za-z0-9_./-]+$/.test(value);
}

function validateToken(value: string): string {
  if (typeof value !== "string" || !/^\d+:[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("Telegram bot token is invalid");
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Telegram Bot API base URL is invalid");
  }
  if (url.protocol !== "https:" && !isLocalHttp(url)) {
    throw new TypeError("Telegram Bot API base URL must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function isLocalHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  );
}

function responseRetryAfter(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parameters = object(value, "Telegram response parameters");
  return optionalInteger(parameters.retry_after);
}

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
    result.message = telegramMessage(raw.message, `${label}.message`);
  }
  if (raw.edited_message !== undefined) {
    result.edited_message = telegramMessage(raw.edited_message, `${label}.edited_message`);
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
  if (raw.user !== undefined) result.user = telegramUser(raw.user, `${label}.user`);
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
    from: telegramUser(raw.from, `${label}.from`),
  };
  if (raw.message !== undefined) result.message = telegramMessage(raw.message, `${label}.message`);
  const data = optionalString(raw.data);
  if (data !== undefined) result.data = data;
  return result;
}

function telegramMessage(value: unknown, label: string): TelegramMessage {
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
  if (raw.from !== undefined) result.from = telegramUser(raw.from, `${label}.from`);
  const text = optionalString(raw.text);
  if (text !== undefined) result.text = text;
  if (raw.entities !== undefined)
    result.entities = telegramEntities(raw.entities, `${label}.entities`);
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
    result.reply_to_message = telegramMessage(raw.reply_to_message, `${label}.reply_to_message`);
  }
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
    return {
      file_id: nonemptyString(raw.file_id, `${itemLabel}.file_id`),
      width: positiveInteger(raw.width, `${itemLabel}.width`),
      height: positiveInteger(raw.height, `${itemLabel}.height`),
      ...(fileSize === undefined ? {} : { file_size: fileSize }),
    };
  });
}

function telegramMediaFile(value: unknown, label: string): TelegramMediaFile {
  const raw = object(value, label);
  const fileName = optionalString(raw.file_name);
  const mediaType = optionalString(raw.mime_type);
  const fileSize = optionalNonnegativeInteger(raw.file_size, `${label}.file_size`);
  return {
    file_id: nonemptyString(raw.file_id, `${label}.file_id`),
    ...(fileName === undefined ? {} : { file_name: fileName }),
    ...(mediaType === undefined ? {} : { mime_type: mediaType }),
    ...(fileSize === undefined ? {} : { file_size: fileSize }),
  };
}

function telegramUser(value: unknown, label: string): TelegramUser {
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
    if (raw.user !== undefined) result.user = telegramUser(raw.user, `${itemLabel}.user`);
    return result;
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} was not a string`);
  return value;
}

function nonemptyString(value: unknown, label: string): string {
  const result = string(value, label);
  if (result.length === 0) throw new TypeError(`${label} was empty`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : string(value, "Telegram field");
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

function optionalNonnegativeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonnegativeInteger(value, label);
}

function optionalInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : integer(value, "Telegram field");
}
