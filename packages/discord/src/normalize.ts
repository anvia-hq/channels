import type { ChannelMessageEvent } from "@anvia/channel";
import { isDiscordSnowflake } from "./snowflake.js";
import type { DiscordGatewayMessage } from "./types.js";

export function normalizeDiscordMessage(
  message: DiscordGatewayMessage,
): ChannelMessageEvent<DiscordGatewayMessage> | undefined {
  if (!validDiscordMessage(message) || message.system || message.content.length === 0) {
    return undefined;
  }

  const threadId = message.thread ? message.channelId : undefined;
  const conversationId = message.thread
    ? (message.parentChannelId ?? message.channelId)
    : message.channelId;

  return {
    type: "message",
    id: message.id,
    platform: "discord",
    accountId: message.bot.id,
    conversation: {
      id: conversationId,
      kind: message.direct ? "direct" : "channel",
      ...(threadId === undefined ? {} : { threadId }),
    },
    sender: {
      id: message.author.id,
      displayName:
        message.memberDisplayName ?? message.author.globalName ?? message.author.username,
      bot: message.author.bot,
    },
    text: message.content,
    mentionedBot: message.mentionedBot,
    raw: message,
  };
}

function validDiscordMessage(message: DiscordGatewayMessage): boolean {
  return (
    isDiscordSnowflake(message.id) &&
    isDiscordSnowflake(message.channelId) &&
    (message.guildId === undefined || isDiscordSnowflake(message.guildId)) &&
    (message.parentChannelId === undefined || isDiscordSnowflake(message.parentChannelId)) &&
    validUser(message.author) &&
    validUser(message.bot) &&
    typeof message.content === "string" &&
    typeof message.direct === "boolean" &&
    typeof message.thread === "boolean" &&
    typeof message.system === "boolean" &&
    typeof message.mentionedBot === "boolean"
  );
}

function validUser(user: DiscordGatewayUserLike): boolean {
  return (
    isDiscordSnowflake(user.id) &&
    typeof user.username === "string" &&
    user.username.length > 0 &&
    (user.globalName === undefined || typeof user.globalName === "string") &&
    typeof user.bot === "boolean"
  );
}

type DiscordGatewayUserLike = DiscordGatewayMessage["author"];
