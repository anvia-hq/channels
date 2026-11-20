import { telegram, type TelegramChannel } from "@anvia/telegram";
import type { TelegramAgentConfig } from "./types.js";

export function createTelegramChannel(config: TelegramAgentConfig): TelegramChannel {
  return telegram({
    token: config.telegramToken,
    onError(error, context) {
      process.stderr.write(`[telegram:${context.operation}] ${String(error)}\n`);
    },
  });
}
