import type {
  Channel,
  ChannelAddress,
  ChannelAttachment,
  ChannelAttachmentData,
  ChannelEventHandler,
  ChannelMessage,
  ChannelMessageEvent,
  SentChannelMessage,
} from "@anvia/channel";
import { splitChannelMessage, validateChannelMessage } from "@anvia/channel";
import {
  TelegramApiError,
  createTelegramBotApiClient,
  parseTelegramUpdate,
} from "./bot-api-client.js";
import { normalizeTelegramUpdate } from "./normalize.js";
import type {
  TelegramBotApi,
  TelegramGetUpdatesRequest,
  TelegramSendAttachmentRequest,
  TelegramSendChatActionRequest,
  TelegramSendMessageRequest,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_POLL_LIMIT = 100;
const MAX_MESSAGE_LENGTH = 4_096;
const MAX_REMEMBERED_UPDATES = 1_000;

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export type TelegramPollingOptions = Readonly<{
  timeoutSeconds?: number;
  retryDelayMs?: number;
  limit?: number;
}>;

export type TelegramChannelErrorContext = Readonly<{
  operation: "poll" | "handle";
  update?: TelegramUpdate;
  /** Bot API error_code when the failure originated from Telegram itself. */
  errorCode?: number;
}>;

export type TelegramWebhookOptions = Readonly<{
  /** Value expected from Telegram's X-Telegram-Bot-Api-Secret-Token header. */
  secretToken: string;
}>;

type TelegramChannelCommonOptions = Readonly<{
  polling?: TelegramPollingOptions;
  webhook?: TelegramWebhookOptions;
  onError?: (error: unknown, context: TelegramChannelErrorContext) => void | Promise<void>;
}>;

export type TelegramChannelOptions = TelegramChannelCommonOptions &
  (
    | Readonly<{
        token: string;
        api?: never;
        baseUrl?: string;
        fetch?: typeof globalThis.fetch;
        maximumAttachmentBytes?: number;
      }>
    | Readonly<{
        api: TelegramBotApi;
        token?: never;
        baseUrl?: never;
        fetch?: never;
        maximumAttachmentBytes?: never;
      }>
  );

export function telegram(options: TelegramChannelOptions): TelegramChannel {
  return new TelegramChannel(options);
}

export class TelegramChannel implements Channel<TelegramUpdate> {
  readonly platform = "telegram";
  readonly capabilities = {
    actions: true,
    outboundAttachments: ["image", "audio", "video", "file"],
    replies: true,
    typing: true,
    reactions: true,
    delete: true,
    messageEdits: true,
  } as const;

  private readonly api: TelegramBotApi;
  private readonly polling: Required<TelegramPollingOptions>;
  private readonly onError: TelegramChannelCommonOptions["onError"];
  private readonly webhook: Readonly<{ secretToken: string }> | undefined;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private handler: ChannelEventHandler<TelegramUpdate> | undefined;
  private bot: TelegramUser | undefined;
  private readonly handledWebhookUpdates = new Set<number>();
  private readonly webhookDeliveries = new Map<number, Promise<void>>();

  constructor(options: TelegramChannelOptions) {
    if (options.webhook !== undefined && options.polling !== undefined) {
      throw new TypeError("Telegram polling and webhook options are mutually exclusive");
    }
    if (options.api !== undefined && options.api !== null) {
      this.api = options.api;
    } else {
      const clientOptions: {
        token: string;
        baseUrl?: string;
        fetch?: typeof globalThis.fetch;
        maximumAttachmentBytes?: number;
      } = { token: options.token };
      if (options.baseUrl !== undefined) clientOptions.baseUrl = options.baseUrl;
      if (options.fetch !== undefined) clientOptions.fetch = options.fetch;
      if (options.maximumAttachmentBytes !== undefined) {
        clientOptions.maximumAttachmentBytes = options.maximumAttachmentBytes;
      }
      this.api = createTelegramBotApiClient(clientOptions);
    }
    this.polling = resolvePollingOptions(options.polling);
    this.webhook = resolveWebhookOptions(options.webhook);
    this.onError = options.onError;
  }

  splitMessage(message: ChannelMessage): readonly ChannelMessage[] {
    return splitChannelMessage(message, MAX_MESSAGE_LENGTH);
  }

  loadAttachment(
    _event: ChannelMessageEvent<TelegramUpdate>,
    attachment: ChannelAttachment,
    signal?: AbortSignal,
  ): Promise<ChannelAttachmentData> {
    return this.api.downloadFile(attachment.id, signal);
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

    if (this.webhook !== undefined) {
      this.handler = handler;
      this.bot = bot;
      return;
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
    await Promise.allSettled(this.webhookDeliveries.values());
    if (this.controller === controller) this.controller = undefined;
    this.handler = undefined;
    this.bot = undefined;
  }

  async receiveWebhook(value: unknown, secretToken?: string): Promise<void> {
    const webhook = this.webhook;
    if (webhook === undefined) throw new Error("Telegram webhook transport is not configured");
    const controller = this.controller;
    const handler = this.handler;
    const bot = this.bot;
    if (controller === undefined || handler === undefined || bot === undefined) {
      throw new Error("Telegram channel is not running");
    }
    if (!sameSecret(webhook.secretToken, secretToken)) {
      throw new Error("Telegram webhook secret token is invalid");
    }
    const update = parseTelegramUpdate(value);
    if (this.handledWebhookUpdates.has(update.update_id)) return;
    const existingDelivery = this.webhookDeliveries.get(update.update_id);
    if (existingDelivery !== undefined) return existingDelivery;
    const delivery = Promise.resolve().then(() =>
      this.deliverWebhookUpdate(update, handler, bot, controller),
    );
    this.webhookDeliveries.set(update.update_id, delivery);
    try {
      await delivery;
    } finally {
      if (this.webhookDeliveries.get(update.update_id) === delivery) {
        this.webhookDeliveries.delete(update.update_id);
      }
    }
  }

  private async deliverWebhookUpdate(
    update: TelegramUpdate,
    handler: ChannelEventHandler<TelegramUpdate>,
    bot: TelegramUser,
    controller: AbortController,
  ): Promise<void> {
    if (update.callback_query !== undefined) {
      await this.api.answerCallbackQuery(
        { callback_query_id: update.callback_query.id },
        controller.signal,
      );
    }
    if (controller.signal.aborted) return;
    const events = normalizeTelegramUpdate(update, bot).filter(
      (event) => !("sender" in event) || !event.sender.bot,
    );
    if (events.length === 0) {
      rememberUpdate(this.handledWebhookUpdates, update.update_id);
      return;
    }
    try {
      for (const event of events) await handler(event);
      rememberUpdate(this.handledWebhookUpdates, update.update_id);
    } catch (error) {
      await this.reportError(error, { operation: "handle", update });
      throw error;
    }
  }

  async send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage> {
    validateAddress(address);
    validateMessage(message);
    const threadId = optionalPositiveInteger(address.threadId, "Telegram thread ID");
    const target = chatId(address.conversationId);
    const replyMessageId = optionalPositiveInteger(
      message.replyToMessageId,
      "Telegram reply message ID",
    );
    let sent: Awaited<ReturnType<TelegramBotApi["sendMessage"]>> | undefined;
    if (message.text.length > 0) {
      const request: Mutable<TelegramSendMessageRequest> = {
        chat_id: target,
        text: message.text,
      };
      if (threadId !== undefined) request.message_thread_id = threadId;
      if (replyMessageId !== undefined) {
        request.reply_parameters = { message_id: replyMessageId };
      }
      const replyMarkup = telegramReplyMarkup(message);
      if ("reply_markup" in replyMarkup) request.reply_markup = replyMarkup.reply_markup;
      sent = await this.api.sendMessage(request);
    }
    for (const [index, attachment] of (message.attachments ?? []).entries()) {
      const request: Mutable<TelegramSendAttachmentRequest> = {
        chat_id: target,
        attachment,
      };
      if (threadId !== undefined) request.message_thread_id = threadId;
      if (sent === undefined && replyMessageId !== undefined) {
        request.reply_parameters = { message_id: replyMessageId };
      }
      if (sent === undefined && index === 0) {
        const replyMarkup = telegramReplyMarkup(message);
        if ("reply_markup" in replyMarkup) request.reply_markup = replyMarkup.reply_markup;
      }
      const mediaMessage = await this.api.sendAttachment(request);
      sent ??= mediaMessage;
    }
    if (sent === undefined) throw new Error("Telegram message did not produce a sent message");
    const sentAddress: {
      platform: string;
      accountId?: string;
      conversationId: string;
      threadId?: string;
    } = {
      platform: this.platform,
      conversationId: String(sent.chat.id),
    };
    if (address.accountId !== undefined) sentAddress.accountId = address.accountId;
    const sentThreadId = sent.message_thread_id ?? threadId;
    if (sentThreadId !== undefined) sentAddress.threadId = String(sentThreadId);
    return {
      id: String(sent.message_id),
      address: sentAddress,
    };
  }

  async edit(sent: SentChannelMessage, message: ChannelMessage): Promise<void> {
    validateAddress(sent.address);
    validateMessage(message);
    if (message.attachments !== undefined || message.replyToMessageId !== undefined) {
      throw new TypeError("Telegram message attachments and replies cannot be edited");
    }
    await this.api.editMessageText({
      chat_id: chatId(sent.address.conversationId),
      message_id: positiveInteger(sent.id, "Telegram message ID"),
      text: message.text,
      ...telegramReplyMarkup(message, true),
    });
  }

  async delete(sent: SentChannelMessage): Promise<void> {
    validateSentMessage(sent);
    await this.api.deleteMessage({
      chat_id: chatId(sent.address.conversationId),
      message_id: positiveInteger(sent.id, "Telegram message ID"),
    });
  }

  async showTyping(address: ChannelAddress): Promise<void> {
    validateAddress(address);
    const threadId = optionalPositiveInteger(address.threadId, "Telegram thread ID");
    const request: Mutable<TelegramSendChatActionRequest> = {
      chat_id: chatId(address.conversationId),
      action: "typing",
    };
    if (threadId !== undefined) request.message_thread_id = threadId;
    await this.api.sendChatAction(request);
  }

  async react(sent: SentChannelMessage, reaction: string): Promise<void> {
    validateSentMessage(sent);
    if (typeof reaction !== "string" || reaction.length === 0) {
      throw new TypeError("Telegram reaction must not be empty");
    }
    await this.api.setMessageReaction({
      chat_id: chatId(sent.address.conversationId),
      message_id: positiveInteger(sent.id, "Telegram message ID"),
      reaction: [{ type: "emoji", emoji: reaction }],
    });
  }

  private async poll(
    handler: ChannelEventHandler<TelegramUpdate>,
    bot: TelegramUser,
    signal: AbortSignal,
  ): Promise<void> {
    let offset: number | undefined;
    const handledUpdates = new Set<number>();
    let pollFailures = 0;

    while (!signal.aborted) {
      let updates: readonly TelegramUpdate[];
      try {
        const request: Mutable<TelegramGetUpdatesRequest> = {
          limit: this.polling.limit,
          timeout: this.polling.timeoutSeconds,
          allowed_updates: ["message", "edited_message", "message_reaction", "callback_query"],
        };
        if (offset !== undefined) request.offset = offset;
        const batch = await this.api.getUpdates(request, signal);
        updates = batch.updates;
        pollFailures = 0;
        for (const invalid of batch.invalid) {
          await this.reportError(invalid.error, { operation: "poll" });
          if (invalid.updateId !== undefined) offset = nextOffset(offset, invalid.updateId);
        }
      } catch (error) {
        if (signal.aborted) break;
        pollFailures += 1;
        const context: Mutable<TelegramChannelErrorContext> = { operation: "poll" };
        if (error instanceof TelegramApiError && error.errorCode !== undefined) {
          context.errorCode = error.errorCode;
        }
        await this.reportError(error, context);
        await abortableDelay(retryDelay(error, this.polling.retryDelayMs, pollFailures), signal);
        continue;
      }

      let handlerFailed = false;
      for (const update of updates) {
        if (signal.aborted) break;
        if (handledUpdates.has(update.update_id)) {
          offset = nextOffset(offset, update.update_id);
          continue;
        }

        if (update.callback_query !== undefined) {
          try {
            await this.api.answerCallbackQuery(
              { callback_query_id: update.callback_query.id },
              signal,
            );
          } catch (error) {
            if (signal.aborted) break;
            await this.reportError(error, { operation: "handle", update });
            handlerFailed = true;
            break;
          }
        }
        const events = normalizeTelegramUpdate(update, bot).filter(
          (event) => !("sender" in event) || !event.sender.bot,
        );
        if (events.length === 0) {
          offset = nextOffset(offset, update.update_id);
          rememberUpdate(handledUpdates, update.update_id);
          continue;
        }

        try {
          for (const event of events) await handler(event);
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

function resolveWebhookOptions(
  options: TelegramWebhookOptions | undefined,
): Readonly<{ secretToken: string }> | undefined {
  if (options === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(options.secretToken)) {
    throw new TypeError("Telegram webhook secret token is invalid");
  }
  return { secretToken: options.secretToken };
}

function validateAddress(address: ChannelAddress): void {
  if (address.platform !== "telegram") {
    throw new TypeError(`Telegram channel cannot use a ${address.platform} address`);
  }
  chatId(address.conversationId);
  optionalPositiveInteger(address.threadId, "Telegram thread ID");
}

function validateMessage(message: ChannelMessage): void {
  if (
    typeof message.text !== "string" ||
    (message.text.length === 0 && message.attachments === undefined)
  ) {
    throw new TypeError("Telegram message must include text or attachments");
  }
  if (message.text.length > MAX_MESSAGE_LENGTH) {
    throw new RangeError(`Telegram message text must not exceed ${MAX_MESSAGE_LENGTH} characters`);
  }
  validateChannelMessage(message);
  optionalPositiveInteger(message.replyToMessageId, "Telegram reply message ID");
}

function validateSentMessage(sent: SentChannelMessage): void {
  validateAddress(sent.address);
  positiveInteger(sent.id, "Telegram message ID");
}

function sameSecret(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function telegramReplyMarkup(
  message: ChannelMessage,
  editing = false,
):
  | Readonly<{
      reply_markup: {
        inline_keyboard: readonly (readonly { text: string; callback_data: string }[])[];
      };
    }>
  | Record<string, never> {
  if (message.actions === undefined) {
    return editing ? { reply_markup: { inline_keyboard: [] } } : {};
  }
  return {
    reply_markup: {
      inline_keyboard: [
        message.actions.map((action) => ({ text: action.label, callback_data: action.id })),
      ],
    },
  };
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

const MAX_RETRY_DELAY_MS = 30_000;

function retryDelay(error: unknown, fallback: number, attempt: number): number {
  if (error instanceof TelegramApiError && error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds * 1_000;
  }
  return Math.min(fallback * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
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
import { timingSafeEqual } from "node:crypto";
