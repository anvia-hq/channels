import type { JsonObject, MemoryScope } from "@anvia/core";
import type { ChannelEvent, ChannelMessageEvent } from "@anvia/channel";

export function defaultShouldHandleChannelEvent(event: ChannelMessageEvent): boolean {
  return !event.sender.bot && (event.conversation.kind === "direct" || event.mentionedBot);
}

export function channelConversationSession(event: ChannelMessageEvent): MemoryScope {
  return {
    sessionId: channelConversationKey(event),
    metadata: channelSessionMetadata(event),
  };
}

export function channelConversationUserSession(event: ChannelMessageEvent): MemoryScope {
  return {
    ...channelConversationSession(event),
    userId: `${encode(event.platform)}:${encode(event.sender.id)}`,
  };
}

export function defaultChannelAgentSession(event: ChannelMessageEvent): MemoryScope {
  return channelConversationUserSession(event);
}

export function channelConversationKey(event: ChannelEvent): string {
  return [
    "channel",
    encode(event.platform),
    optionalIdentifier(event.accountId, "default"),
    encode(event.conversation.id),
    optionalIdentifier(event.conversation.threadId, "root"),
  ].join(":");
}

function channelSessionMetadata(event: ChannelMessageEvent): JsonObject {
  const metadata: JsonObject = {
    platform: event.platform,
    conversationId: event.conversation.id,
    conversationKind: event.conversation.kind,
  };
  if (event.accountId !== undefined) metadata.accountId = event.accountId;
  if (event.conversation.threadId !== undefined) {
    metadata.threadId = event.conversation.threadId;
  }

  return metadata;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function optionalIdentifier(value: string | undefined, missing: string): string {
  if (value === undefined) return missing;
  const encoded = encode(value);
  return encoded === missing || encoded.startsWith("~") ? `~${encoded}` : encoded;
}
