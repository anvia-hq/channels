import { readBoundedResponseBuffer } from "@anvia/channel/adapter";
import {
  nonemptyString,
  object,
  optionalInteger,
  optionalNonnegativeInteger,
  optionalString,
  parseTelegramMessage,
  parseTelegramUpdate,
  parseTelegramUser,
  rawUpdateId,
} from "./parse.js";
import type { TelegramBotApi, TelegramInvalidUpdate, TelegramUpdate } from "./types.js";

export { parseTelegramUpdate };

const DEFAULT_BASE_URL = "https://api.telegram.org";
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_RATE_LIMIT_ATTEMPTS = 3;

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
      const requestInit: RequestInit = {
        method: "POST",
        body,
      };

      if (contentType !== undefined) requestInit.headers = { "content-type": contentType };

      if (signal !== undefined) requestInit.signal = signal;

      response = await fetchImplementation(`${baseUrl}/bot${token}/${method}`, requestInit);
    } catch (error) {
      if (signal?.aborted === true) throw error;

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
      const errorOptions: { errorCode?: number; retryAfterSeconds?: number } = {};

      if (errorCode !== undefined) errorOptions.errorCode = errorCode;

      if (retryAfterSeconds !== undefined) {
        errorOptions.retryAfterSeconds = retryAfterSeconds;
      }

      throw new TelegramApiError(
        method,
        optionalString(envelope.description) ?? `HTTP ${response.status}`,
        errorOptions,
      );
    }

    if (!("result" in envelope)) {
      throw new TelegramApiError(method, "response did not include a result");
    }

    return envelope.result;
  };

  const call = (method: string, body: object, signal?: AbortSignal) =>
    request(method, JSON.stringify(body), "application/json", signal);

  const executeWithRateLimitRetry = async (
    sendAttempt: () => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await sendAttempt();
      } catch (error) {
        const retryable =
          error instanceof TelegramApiError &&
          error.errorCode === 429 &&
          attempt < MAX_RATE_LIMIT_ATTEMPTS &&
          signal?.aborted !== true;

        if (!retryable) throw error;

        await abortableRateLimitSleep(Math.max(1, error.retryAfterSeconds ?? 1) * 1_000, signal);
      }
    }
  };

  const callWithRateLimitRetry = (method: string, body: object, signal?: AbortSignal) =>
    executeWithRateLimitRetry(() => call(method, body, signal), signal);

  return {
    async getMe(signal) {
      return parseTelegramUser(await call("getMe", {}, signal), "getMe result");
    },

    async getUpdates(getUpdatesRequest, signal) {
      const result = await call("getUpdates", getUpdatesRequest, signal);

      if (!Array.isArray(result)) {
        throw new TelegramApiError("getUpdates", "result was not an array");
      }

      const updates: TelegramUpdate[] = [];
      const invalid: TelegramInvalidUpdate[] = [];
      for (const [index, raw] of result.entries()) {
        try {
          updates.push(parseTelegramUpdate(raw, `getUpdates result[${index}]`));
        } catch (error) {
          invalid.push({ updateId: rawUpdateId(raw), error });
        }
      }
      return { updates, invalid };
    },

    async sendMessage(sendRequest, signal) {
      return parseTelegramMessage(
        await callWithRateLimitRetry("sendMessage", sendRequest, signal),
        "sendMessage result",
      );
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
      const common: Record<string, unknown> = { chat_id: sendRequest.chat_id };

      if (sendRequest.message_thread_id !== undefined) {
        common.message_thread_id = sendRequest.message_thread_id;
      }

      if (sendRequest.caption !== undefined) common.caption = sendRequest.caption;

      if (sendRequest.reply_parameters !== undefined) {
        common.reply_parameters = sendRequest.reply_parameters;
      }

      if (sendRequest.reply_markup !== undefined) common.reply_markup = sendRequest.reply_markup;

      let result: unknown;

      if (sendRequest.attachment.source.type === "url") {
        result = await callWithRateLimitRetry(
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

        const mediaType = sendRequest.attachment.mediaType;
        const filename = sendRequest.attachment.filename ?? "attachment";
        result = await executeWithRateLimitRetry(() => {
          const form = new FormData();
          for (const [key, value] of Object.entries(common)) {
            form.set(key, typeof value === "string" ? value : JSON.stringify(value));
          }
          form.set(field, new Blob([bytes], { type: mediaType }), filename);
          return request(method, form, undefined, signal);
        }, signal);
      }

      return parseTelegramMessage(result, `${method} result`);
    },

    async editMessageText(editRequest, signal) {
      const result = await callWithRateLimitRetry("editMessageText", editRequest, signal);

      if (result === true) return true;

      return parseTelegramMessage(result, "editMessageText result");
    },

    async answerCallbackQuery(answerRequest, signal) {
      return trueResult(
        "answerCallbackQuery",
        await call("answerCallbackQuery", answerRequest, signal),
      );
    },

    async deleteMessage(deleteRequest, signal) {
      return trueResult(
        "deleteMessage",
        await callWithRateLimitRetry("deleteMessage", deleteRequest, signal),
      );
    },

    async sendChatAction(actionRequest, signal) {
      return trueResult("sendChatAction", await call("sendChatAction", actionRequest, signal));
    },

    async setMessageReaction(reactionRequest, signal) {
      return trueResult(
        "setMessageReaction",
        await callWithRateLimitRetry("setMessageReaction", reactionRequest, signal),
      );
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
        const buffer = await readBoundedResponseBuffer(response, {
          maximumBytes: maximumAttachmentBytes,
          label: "Telegram attachment",
        });
        return { type: "data", data: buffer.toString("base64") };
      } catch (error) {
        if (error instanceof RangeError || signal?.aborted === true) throw error;

        throw new TelegramApiError("downloadFile", "response body could not be read");
      }
    },
  };
}

function abortableRateLimitSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new TelegramApiError("request", "aborted while waiting for rate limit"));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TelegramApiError("request", "aborted while waiting for rate limit"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
