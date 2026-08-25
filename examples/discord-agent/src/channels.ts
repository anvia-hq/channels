import { discord, type DiscordChannel } from "@anvia/discord";
import type { DiscordAgentConfig } from "./types.js";

export function createDiscordChannel(config: DiscordAgentConfig): DiscordChannel {
  return discord({
    token: config.discordToken,
    onError(error, context) {
      process.stderr.write(`[discord:${context.operation}] ${String(error)}\n`);
    },
  });
}
