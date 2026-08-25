import { isSlackId, isSlackTimestamp } from "./identifiers.js";
import type { SlackChannelType, SlackIdentity, SlackSocketMessage } from "./types.js";

export function parseSlackSocketEvent(
  body: unknown,
  identity: SlackIdentity,
): SlackSocketMessage | undefined {
  if (!isRecord(body) || body.type !== "event_callback" || !nonemptyString(body.event_id)) {
    return undefined;
  }
  const event = body.event;
  if (!isRecord(event) || (event.type !== "message" && event.type !== "app_mention")) {
    return undefined;
  }
  if (!supportedSubtype(event.type, event.subtype)) return undefined;
  if (!isSlackId(event.channel) || !isSlackTimestamp(event.ts) || typeof event.text !== "string") {
    return undefined;
  }

  const senderId = isSlackId(event.user)
    ? event.user
    : isSlackId(event.bot_id)
      ? event.bot_id
      : undefined;
  if (senderId === undefined) return undefined;

  const teamId = isSlackId(body.team_id) ? body.team_id : identity.teamId;
  const channelType = slackChannelType(event.channel_type, event.channel);
  const threadTimestamp = isSlackTimestamp(event.thread_ts) ? event.thread_ts : undefined;
  const senderDisplayName = displayName(event.user_profile);

  return {
    eventId: body.event_id,
    type: event.type,
    teamId,
    channelId: event.channel,
    channelType,
    timestamp: event.ts,
    ...(threadTimestamp === undefined ? {} : { threadTimestamp }),
    senderId,
    ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
    senderBot:
      isSlackId(event.bot_id) || isSlackId(event.app_id) || senderId === identity.botUserId,
    text: event.text,
    botUserId: identity.botUserId,
  };
}

function supportedSubtype(type: "message" | "app_mention", subtype: unknown): boolean {
  if (subtype === undefined) return true;
  return type === "message" && subtype === "thread_broadcast";
}

function slackChannelType(value: unknown, channelId: string): SlackChannelType {
  switch (value) {
    case "channel":
    case "group":
    case "im":
    case "mpim":
    case "app_home":
      return value;
  }
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "group";
  return "channel";
}

function displayName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const candidate of [value.display_name, value.real_name, value.name]) {
    if (nonemptyString(candidate)) return candidate;
  }
  return undefined;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
