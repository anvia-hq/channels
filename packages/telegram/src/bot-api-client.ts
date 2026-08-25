import type {
  TelegramBotApi,
  TelegramChat,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.telegram.org";

export type TelegramBotApiClientOptions = Readonly<{
  token: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
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

  if (typeof fetchImplementation !== "function") {
    throw new TypeError("A Fetch API implementation is required");
  }

  const call = async (method: string, body: object, signal?: AbortSignal): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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

  return {
    async getMe(signal) {
      return telegramUser(await call("getMe", {}, signal), "getMe result");
    },

    async getUpdates(request, signal) {
      const result = await call("getUpdates", request, signal);
      if (!Array.isArray(result)) {
        throw new TelegramApiError("getUpdates", "result was not an array");
      }
      return result.map((update, index) => telegramUpdate(update, `getUpdates result[${index}]`));
    },

    async sendMessage(request, signal) {
      return telegramMessage(await call("sendMessage", request, signal), "sendMessage result");
    },

    async editMessageText(request, signal) {
      const result = await call("editMessageText", request, signal);
      if (result === true) return true;
      return telegramMessage(result, "editMessageText result");
    },
  };
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

function telegramUpdate(value: unknown, label: string): TelegramUpdate {
  const raw = object(value, label);
  const updateId = integer(raw.update_id, `${label}.update_id`);
  if (raw.message === undefined) return { update_id: updateId };
  return { update_id: updateId, message: telegramMessage(raw.message, `${label}.message`) };
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
  if (raw.reply_to_message !== undefined) {
    result.reply_to_message = telegramMessage(raw.reply_to_message, `${label}.reply_to_message`);
  }
  return result;
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

function optionalInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : integer(value, "Telegram field");
}
