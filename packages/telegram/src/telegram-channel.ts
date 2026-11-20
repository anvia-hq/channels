import { timingSafeEqual } from "node:crypto";
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
import { splitChannelMessage } from "@anvia/channel";
import {
  BoundedMap,
  BoundedSet,
  reportChannelError,
  validateOutboundChannelMessage,
} from "@anvia/channel/adapter";
import type { Mutable } from "@anvia/channel/adapter";
import { createTelegramBotApiClient, parseTelegramUpdate } from "./bot-api-client.js";
import { normalizeTelegramUpdate } from "./normalize.js";
import type { TelegramNormalizationOptions } from "./normalize.js";
import { pollTelegramUpdates } from "./polling.js";
import type {
  TelegramBotApi,
  TelegramSendAttachmentRequest,
  TelegramSendChatActionRequest,
  TelegramSendMessageRequest,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_POLL_LIMIT = 100;
const DEFAULT_MAX_HANDLER_ATTEMPTS = 10;
const MAX_MESSAGE_LENGTH = 4_096;
const MAX_REMEMBERED_UPDATES = 1_000;
const MAX_REMEMBERED_REACTIONS = 1_000;

export type TelegramPollingOptions = Readonly<{
  timeoutSeconds?: number;
  retryDelayMs?: number;
  limit?: number;
}>;

export type TelegramChannelErrorContext = Readonly<{
  operation: "poll" | "handle";
  update?: TelegramUpdate;

  errorCode?: number;

  poisoned?: boolean;
}>;

export type TelegramWebhookOptions = Readonly<{
  secretToken: string;
}>;

type TelegramChannelCommonOptions = Readonly<{
  polling?: TelegramPollingOptions;
  webhook?: TelegramWebhookOptions;

  maxHandlerAttempts?: number;
  onError?: (error: unknown, context: TelegramChannelErrorContext) => void | Promise<void>;
}>;

export type TelegramChannelOptions = TelegramChannelCommonOptions &
  TelegramNormalizationOptions &
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
    reactionRemovals: true,
    delete: true,
    messageEdits: true,
  } as const;

  private readonly api: TelegramBotApi;
  private readonly polling: Required<TelegramPollingOptions>;
  private readonly maxHandlerAttempts: number;
  private readonly normalization: TelegramNormalizationOptions;
  private readonly onError: TelegramChannelCommonOptions["onError"];
  private readonly webhook: Readonly<{ secretToken: string }> | undefined;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private handler: ChannelEventHandler<TelegramUpdate> | undefined;
  private bot: TelegramUser | undefined;
  private readonly handledWebhookUpdates = new BoundedSet<number>(MAX_REMEMBERED_UPDATES);
  private readonly webhookDeliveries = new Map<number, Promise<void>>();
  private readonly webhookAttempts = new BoundedMap<number, number>(MAX_REMEMBERED_UPDATES);
  private readonly reactions = new BoundedMap<string, string>(MAX_REMEMBERED_REACTIONS);
  private readonly reactionWrites = new Map<string, Promise<void>>();

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
    this.normalization = { allowBareGroupCommands: options.allowBareGroupCommands === true };
    this.webhook = resolveWebhookOptions(options.webhook);
    this.maxHandlerAttempts = resolveMaxHandlerAttempts(options.maxHandlerAttempts);
    this.onError = options.onError;
  }

  splitMessage(message: ChannelMessage): readonly ChannelMessage[] {
    return splitChannelMessage({ message, maximumLength: MAX_MESSAGE_LENGTH });
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

    this.loop = pollTelegramUpdates({
      api: this.api,
      polling: this.polling,
      maxHandlerAttempts: this.maxHandlerAttempts,
      normalization: this.normalization,
      handler,
      bot,
      signal: controller.signal,
      acknowledgeCallbackQuery: (update, signal) => this.acknowledgeCallbackQuery(update, signal),
      reportError: (error, context) => this.reportError(error, context),
    }).finally(() => {
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
    this.webhookAttempts.clear();
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
    validateSentMessage(sent);
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
    await this.updateReaction(sent, reaction, false);
  }

  async unreact(sent: SentChannelMessage, reaction: string): Promise<void> {
    await this.updateReaction(sent, reaction, true);
  }

  private async deliverWebhookUpdate(
    update: TelegramUpdate,
    handler: ChannelEventHandler<TelegramUpdate>,
    bot: TelegramUser,
    controller: AbortController,
  ): Promise<void> {
    await this.acknowledgeCallbackQuery(update, controller.signal);

    if (controller.signal.aborted) return;

    const events = normalizeTelegramUpdate(update, bot, this.normalization).filter(
      (event) => !("sender" in event) || !event.sender.bot,
    );

    if (events.length === 0) {
      this.handledWebhookUpdates.add(update.update_id);
      return;
    }

    try {
      for (const event of events) await handler(event);
      this.handledWebhookUpdates.add(update.update_id);
      this.webhookAttempts.delete(update.update_id);
    } catch (error) {
      const attempts = (this.webhookAttempts.get(update.update_id) ?? 0) + 1;

      if (attempts >= this.maxHandlerAttempts) {
        this.webhookAttempts.delete(update.update_id);
        this.handledWebhookUpdates.add(update.update_id);
        await this.reportError(error, { operation: "handle", update, poisoned: true });
        return;
      }

      this.webhookAttempts.set(update.update_id, attempts);
      await this.reportError(error, { operation: "handle", update });
      throw error;
    }
  }

  private async updateReaction(
    sent: SentChannelMessage,
    reaction: string,
    remove: boolean,
  ): Promise<void> {
    validateSentMessage(sent);

    if (typeof reaction !== "string" || reaction.length === 0) {
      throw new TypeError("Telegram reaction must not be empty");
    }

    const target = chatId(sent.address.conversationId);
    const messageId = positiveInteger(sent.id, "Telegram message ID");
    const key = JSON.stringify([
      typeof target === "string" ? target.toLowerCase() : target,
      messageId,
    ]);
    const previous = this.reactionWrites.get(key) ?? Promise.resolve();

    const write = previous.then(async () => {
      if (remove && this.reactions.get(key) !== reaction) return;

      try {
        await this.api.setMessageReaction({
          chat_id: target,
          message_id: messageId,
          reaction: remove ? [] : [{ type: "emoji", emoji: reaction }],
        });
      } catch (error) {
        this.reactions.delete(key);
        throw error;
      }

      if (remove) {
        this.reactions.delete(key);
      } else {
        this.reactions.set(key, reaction);
      }
    });

    const settled = write.catch(() => {});
    this.reactionWrites.set(key, settled);
    try {
      await write;
    } finally {
      if (this.reactionWrites.get(key) === settled) this.reactionWrites.delete(key);
    }
  }

  private async acknowledgeCallbackQuery(
    update: TelegramUpdate,
    signal: AbortSignal,
  ): Promise<void> {
    if (update.callback_query === undefined) return;

    try {
      await this.api.answerCallbackQuery({ callback_query_id: update.callback_query.id }, signal);
    } catch (error) {
      if (!signal.aborted) void this.reportError(error, { operation: "handle", update });
    }
  }

  private reportError(error: unknown, context: TelegramChannelErrorContext): Promise<void> {
    return reportChannelError(this.onError, error, context);
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

function resolveMaxHandlerAttempts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_HANDLER_ATTEMPTS;

  return positiveInteger(value, "Telegram maximum handler attempts");
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
  validateOutboundChannelMessage(message, {
    platformLabel: "Telegram",
    maximumLength: MAX_MESSAGE_LENGTH,
  });
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

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be positive`);
  }

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
