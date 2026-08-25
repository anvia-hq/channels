import { slack, type SlackChannel } from "@anvia/slack";
import type { SlackAgentConfig } from "./types.js";

export function createSlackChannel(config: SlackAgentConfig): SlackChannel {
  return slack({
    appToken: config.slackAppToken,
    botToken: config.slackBotToken,
    onError(error, context) {
      process.stderr.write(`[slack:${context.operation}] ${String(error)}\n`);
    },
  });
}
