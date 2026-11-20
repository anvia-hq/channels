import type { ChannelEventHandler } from "@anvia/channel";
import { BoundedMap, BoundedSet } from "@anvia/channel/adapter";
import type { Mutable } from "@anvia/channel/adapter";
import { TelegramApiError } from "./bot-api-client.js";
import { normalizeTelegramUpdate } from "./normalize.js";
import type { TelegramNormalizationOptions } from "./normalize.js";
import type { TelegramChannelErrorContext, TelegramPollingOptions } from "./telegram-channel.js";
import type {
  TelegramBotApi,
  TelegramGetUpdatesRequest,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

const MAX_REMEMBERED_UPDATES = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export async function pollTelegramUpdates(
  options: Readonly<{
    api: TelegramBotApi;
    polling: Required<TelegramPollingOptions>;
    maxHandlerAttempts: number;
    normalization: TelegramNormalizationOptions;
    handler: ChannelEventHandler<TelegramUpdate>;
    bot: TelegramUser;
    signal: AbortSignal;
    acknowledgeCallbackQuery: (update: TelegramUpdate, signal: AbortSignal) => Promise<void>;
    reportError: (error: unknown, context: TelegramChannelErrorContext) => Promise<void>;
  }>,
): Promise<void> {
  const {
    api,
    polling,
    maxHandlerAttempts,
    normalization,
    handler,
    bot,
    signal,
    acknowledgeCallbackQuery,
    reportError,
  } = options;
  let offset: number | undefined;
  const handledUpdates = new BoundedSet<number>(MAX_REMEMBERED_UPDATES);
  const handlerAttempts = new BoundedMap<number, number>(MAX_REMEMBERED_UPDATES);
  let pollFailures = 0;

  while (!signal.aborted) {
    let updates: readonly TelegramUpdate[];
    let malformedOffset: number | undefined;
    try {
      const request: Mutable<TelegramGetUpdatesRequest> = {
        limit: polling.limit,
        timeout: polling.timeoutSeconds,
        allowed_updates: ["message", "edited_message", "message_reaction", "callback_query"],
      };

      if (offset !== undefined) request.offset = offset;

      const batch = await api.getUpdates(request, signal);
      updates = [...batch.updates].sort((left, right) => left.update_id - right.update_id);
      pollFailures = 0;
      for (const invalid of batch.invalid) {
        await reportError(invalid.error, { operation: "poll" });

        if (invalid.updateId !== undefined) {
          malformedOffset = nextOffset(malformedOffset, invalid.updateId);
        }
      }
    } catch (error) {
      if (signal.aborted) break;

      pollFailures += 1;
      const context: Mutable<TelegramChannelErrorContext> = { operation: "poll" };

      if (error instanceof TelegramApiError && error.errorCode !== undefined) {
        context.errorCode = error.errorCode;
      }

      await reportError(error, context);
      await abortableDelay(retryDelay(error, polling.retryDelayMs, pollFailures), signal);
      continue;
    }

    let handlerFailed = false;
    let handlerRetryDelayMs = polling.retryDelayMs;
    for (const update of updates) {
      if (signal.aborted) break;

      if (handledUpdates.has(update.update_id)) {
        offset = nextOffset(offset, update.update_id);
        continue;
      }

      await acknowledgeCallbackQuery(update, signal);

      if (signal.aborted) break;

      const events = normalizeTelegramUpdate(update, bot, normalization).filter(
        (event) => !("sender" in event) || !event.sender.bot,
      );

      if (events.length === 0) {
        offset = nextOffset(offset, update.update_id);
        handledUpdates.add(update.update_id);
        continue;
      }

      try {
        for (const event of events) await handler(event);
        offset = nextOffset(offset, update.update_id);
        handledUpdates.add(update.update_id);
        handlerAttempts.delete(update.update_id);
      } catch (error) {
        const attempts = (handlerAttempts.get(update.update_id) ?? 0) + 1;

        if (attempts >= maxHandlerAttempts) {
          handlerAttempts.delete(update.update_id);
          offset = nextOffset(offset, update.update_id);
          handledUpdates.add(update.update_id);
          await reportError(error, { operation: "handle", update, poisoned: true });
          continue;
        }

        handlerAttempts.set(update.update_id, attempts);
        await reportError(error, { operation: "handle", update });
        handlerFailed = true;
        handlerRetryDelayMs = backoffDelay(polling.retryDelayMs, attempts);
        break;
      }
    }

    if (!handlerFailed && !signal.aborted && malformedOffset !== undefined) {
      offset = Math.max(offset ?? malformedOffset, malformedOffset);
    }

    if (handlerFailed && !signal.aborted) {
      await abortableDelay(handlerRetryDelayMs, signal);
    }
  }
}

function nextOffset(current: number | undefined, updateId: number): number {
  return Math.max(current ?? 0, updateId + 1);
}

function retryDelay(error: unknown, fallback: number, attempt: number): number {
  if (error instanceof TelegramApiError && error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds * 1_000;
  }

  return backoffDelay(fallback, attempt);
}

function backoffDelay(baseMs: number, attempt: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
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
