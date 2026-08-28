import { isChannelActionId } from "@anvia/channel";
import { isSlackId, isSlackTimestamp } from "./identifiers.js";
import type {
  SlackChannelType,
  SlackFile,
  SlackIdentity,
  SlackSocketAction,
  SlackSocketMessage,
} from "./types.js";

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
  const files = slackFiles(event.files);
  if (files === undefined || (event.text.length === 0 && files.length === 0)) return undefined;

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
    files,
    botUserId: identity.botUserId,
  };
}

export function parseSlackSocketInteraction(
  body: unknown,
  identity: SlackIdentity,
): SlackSocketAction | undefined {
  if (!isRecord(body) || body.type !== "block_actions") return undefined;
  const team = body.team;
  const channel = body.channel;
  const user = body.user;
  const message = body.message;
  const actions = body.actions;
  if (
    !isRecord(team) ||
    !isSlackId(team.id) ||
    !isRecord(channel) ||
    !isSlackId(channel.id) ||
    !isRecord(user) ||
    !isSlackId(user.id) ||
    !isRecord(message) ||
    !isSlackTimestamp(message.ts) ||
    !Array.isArray(actions) ||
    actions.length !== 1 ||
    !isRecord(actions[0]) ||
    !isChannelActionId(actions[0].value) ||
    !isSlackTimestamp(actions[0].action_ts)
  ) {
    return undefined;
  }
  const threadTimestamp = isSlackTimestamp(message.thread_ts) ? message.thread_ts : undefined;
  const eventId = nonemptyString(body.trigger_id)
    ? body.trigger_id
    : `${message.ts}:${actions[0].action_ts}`;
  return {
    type: "action",
    eventId,
    teamId: team.id,
    channelId: channel.id,
    channelType: slackChannelType(channel.type, channel.id),
    messageTimestamp: message.ts,
    ...(threadTimestamp === undefined ? {} : { threadTimestamp }),
    senderId: user.id,
    ...(nonemptyString(user.name) ? { senderDisplayName: user.name } : {}),
    actionId: actions[0].value,
    actionTimestamp: actions[0].action_ts,
    botUserId: identity.botUserId,
  };
}

function slackFiles(value: unknown): readonly SlackFile[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const files: SlackFile[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !isSlackId(candidate.id) ||
      (candidate.size !== undefined &&
        (!Number.isSafeInteger(candidate.size) || Number(candidate.size) < 0))
    ) {
      return undefined;
    }
    const privateDownloadUrl = candidate.url_private_download ?? candidate.url_private;
    if (!validPrivateDownloadUrl(privateDownloadUrl)) return undefined;
    files.push({
      id: candidate.id,
      name: nonemptyString(candidate.name) ? candidate.name : candidate.id,
      mediaType: nonemptyString(candidate.mimetype)
        ? candidate.mimetype
        : "application/octet-stream",
      ...(candidate.size === undefined ? {} : { size: Number(candidate.size) }),
      privateDownloadUrl,
    });
  }
  return files;
}

function validPrivateDownloadUrl(value: unknown): value is string {
  if (!nonemptyString(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["slack.com", "slack-files.com", "slack-gov.com"].some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}

function supportedSubtype(type: "message" | "app_mention", subtype: unknown): boolean {
  if (subtype === undefined) return true;
  return type === "message" && (subtype === "thread_broadcast" || subtype === "file_share");
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
