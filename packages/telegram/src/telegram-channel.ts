import type {
  Channel,
  ChannelAddress,
  ChannelEventHandler,
  ChannelMessage,
  SentChannelMessage,
} from "@anvia/channel";
import { TelegramApiError, createTelegramBotApiClient } from "./bot-api-client.js";
import { normalizeTelegramUpdate } from "./normalize.js";
import type { TelegramBotApi, TelegramUpdate, TelegramUser } from "./types.js";

const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_POLL_LIMIT = 100;
const MAX_MESSAGE_LENGTH = 4_096;
const MAX_REMEMBERED_UPDATES = 1_000;

export type TelegramPollingOptions = Readonly<{
  timeoutSeconds?: number;
  retryDelayMs?: number;
  limit?: number;
}>;

export type TelegramChannelErrorContext = Readonly<{
  operation: "poll" | "handle";
  update?: TelegramUpdate;
}>;

type TelegramChannelCommonOptions = Readonly<{
  polling?: TelegramPollingOptions;
  onError?: (error: unknown, context: TelegramChannelErrorContext) => void | Promise<void>;
}>;

export type TelegramChannelOptions = TelegramChannelCommonOptions &
  (
    | Readonly<{
        token: string;
        api?: never;
        baseUrl?: string;
        fetch?: typeof globalThis.fetch;
      }>
    | Readonly<{
        api: TelegramBotApi;
        token?: never;
        baseUrl?: never;
        fetch?: never;
      }>
  );

export function telegram(options: TelegramChannelOptions): TelegramChannel {
  return new TelegramChannel(options);
}

export class TelegramChannel implements Channel<TelegramUpdate> {
  readonly platform = "telegram";

  private readonly api: TelegramBotApi;
  private readonly polling: Required<TelegramPollingOptions>;
  private readonly onError: TelegramChannelCommonOptions["onError"];
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(options: TelegramChannelOptions) {
    this.api =
      options.api ??
      createTelegramBotApiClient({
        token: options.token,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    this.polling = resolvePollingOptions(options.polling);
    this.onError = options.onError;
  }

  async start(handler: ChannelEventHandler<TelegramUpdate>): Promise<void> {
    if (this.controller !== undefined) throw new Error("Telegram channel is already running");
    if (typeof handler !== "function") throw new TypeError("Telegram event handler is required");

    const controller = new AbortController();
    this.controller = controller;
    let bot: TelegramUser;
    try {
      bot = await this.api.getMe(controller.signal);
    } catch (error) {
      if (this.controller === controller) this.controller = undefined;
      throw error;
    }

    this.loop = this.poll(handler, bot, controller.signal).finally(() => {
      if (this.controller === controller) {
        this.controller = undefined;
        this.loop = undefined;
      }
    });
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    const loop = this.loop;
    if (controller === undefined) return;
    controller.abort();
    await loop;
  }

  async send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage> {
    validateAddress(address);
    validateMessage(message);
    const threadId = optionalPositiveInteger(address.threadId, "Telegram thread ID");
    const sent = await this.api.sendMessage({
      chat_id: chatId(address.conversationId),
      text: message.text,
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    });
    return {
      id: String(sent.message_id),
      address: {
        platform: this.platform,
        ...(address.accountId === undefined ? {} : { accountId: address.accountId }),
        conversationId: String(sent.chat.id),
        ...(sent.message_thread_id === undefined
          ? threadId === undefined
            ? {}
            : { threadId: String(threadId) }
          : { threadId: String(sent.message_thread_id) }),
      },
    };
  }

  async edit(sent: SentChannelMessage, message: ChannelMessage): Promise<void> {
    validateAddress(sent.address);
    validateMessage(message);
    await this.api.editMessageText({
      chat_id: chatId(sent.address.conversationId),
      message_id: positiveInteger(sent.id, "Telegram message ID"),
      text: message.text,
    });
  }

  private async poll(
    handler: ChannelEventHandler<TelegramUpdate>,
    bot: TelegramUser,
    signal: AbortSignal,
  ): Promise<void> {
    let offset: number | undefined;
    const handledUpdates = new Set<number>();

    while (!signal.aborted) {
      let updates: readonly TelegramUpdate[];
      try {
        updates = await this.api.getUpdates(
          {
            ...(offset === undefined ? {} : { offset }),
            limit: this.polling.limit,
            timeout: this.polling.timeoutSeconds,
            allowed_updates: ["message"],
          },
          signal,
        );
      } catch (error) {
        if (signal.aborted) break;
        await this.reportError(error, { operation: "poll" });
        await abortableDelay(retryDelay(error, this.polling.retryDelayMs), signal);
        continue;
      }

      let handlerFailed = false;
      for (const update of updates) {
        if (signal.aborted) break;
        if (handledUpdates.has(update.update_id)) {
          offset = nextOffset(offset, update.update_id);
          continue;
        }

        const event = normalizeTelegramUpdate(update, bot);
        if (event === undefined || event.sender.bot) {
          offset = nextOffset(offset, update.update_id);
          rememberUpdate(handledUpdates, update.update_id);
          continue;
        }

        try {
          await handler(event);
          offset = nextOffset(offset, update.update_id);
          rememberUpdate(handledUpdates, update.update_id);
        } catch (error) {
          await this.reportError(error, { operation: "handle", update });
          handlerFailed = true;
          break;
        }
      }

      if (handlerFailed && !signal.aborted) {
        await abortableDelay(this.polling.retryDelayMs, signal);
      }
    }
  }

  private async reportError(error: unknown, context: TelegramChannelErrorContext): Promise<void> {
    try {
      await this.onError?.(error, context);
    } catch {
      // Error observers must not terminate message delivery.
    }
  }
}

function resolvePollingOptions(
  options: TelegramPollingOptions = {},
): Required<TelegramPollingOptions> {
  return {
    timeoutSeconds: positiveInteger(
      options.timeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
      "Telegram polling timeout",
    ),
    retryDelayMs: nonnegativeInteger(
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      "Telegram retry delay",
    ),
    limit: integerInRange(options.limit ?? DEFAULT_POLL_LIMIT, 1, 100, "Telegram polling limit"),
  };
}

function validateAddress(address: ChannelAddress): void {
  if (address.platform !== "telegram") {
    throw new TypeError(`Telegram channel cannot use a ${address.platform} address`);
  }
  chatId(address.conversationId);
  optionalPositiveInteger(address.threadId, "Telegram thread ID");
}

function validateMessage(message: ChannelMessage): void {
  if (typeof message.text !== "string" || message.text.length === 0) {
    throw new TypeError("Telegram message text must not be empty");
  }
  if (message.text.length > MAX_MESSAGE_LENGTH) {
    throw new RangeError(`Telegram message text must not exceed ${MAX_MESSAGE_LENGTH} characters`);
  }
}

function chatId(value: string): number | string {
  if (/^-?\d+$/.test(value)) return safeInteger(value, "Telegram chat ID");
  if (/^@[A-Za-z][A-Za-z0-9_]{3,}$/.test(value)) return value;
  throw new TypeError("Telegram conversation ID must be a numeric chat ID or @username");
}

function optionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

function positiveInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : safeInteger(value, label);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new TypeError(`${label} must be positive`);
  return parsed;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value;
}

function integerInRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${label} must be a safe integer`);
  return parsed;
}

function nextOffset(current: number | undefined, updateId: number): number {
  return Math.max(current ?? 0, updateId + 1);
}

function rememberUpdate(updates: Set<number>, updateId: number): void {
  updates.add(updateId);
  if (updates.size <= MAX_REMEMBERED_UPDATES) return;
  const oldest = updates.values().next().value;
  if (oldest !== undefined) updates.delete(oldest);
}

function retryDelay(error: unknown, fallback: number): number {
  if (error instanceof TelegramApiError && error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds * 1_000;
  }
  return fallback;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
