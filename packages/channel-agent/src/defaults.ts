import type { JsonObject, MemoryScope } from "@anvia/core";
import type { ChannelMessageEvent } from "@anvia/channel";

export function defaultShouldHandleChannelEvent(event: ChannelMessageEvent): boolean {
  return !event.sender.bot && (event.conversation.kind === "direct" || event.mentionedBot);
}

export function defaultChannelAgentSession(event: ChannelMessageEvent): MemoryScope {
  const metadata: JsonObject = {
    platform: event.platform,
    conversationId: event.conversation.id,
    conversationKind: event.conversation.kind,
  };
  if (event.accountId !== undefined) metadata.accountId = event.accountId;
  if (event.conversation.threadId !== undefined) {
    metadata.threadId = event.conversation.threadId;
  }

  return {
    sessionId: channelConversationKey(event),
    userId: `${encode(event.platform)}:${encode(event.sender.id)}`,
    metadata,
  };
}

export function channelConversationKey(event: ChannelMessageEvent): string {
  return [
    "channel",
    event.platform,
    event.accountId ?? "default",
    event.conversation.id,
    event.conversation.threadId ?? "root",
  ]
    .map(encode)
    .join(":");
}

function encode(value: string): string {
  return encodeURIComponent(value);
}
