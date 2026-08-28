import { isChannelActionId } from "@anvia/channel";
import { isSlackId, isSlackTimestamp } from "./identifiers.js";
import type {
  SlackChannelType,
  SlackFile,
  SlackIdentity,
  SlackSocketAction,
  SlackSocketEvent,
  SlackSocketMessage,
  SlackSocketMessageDeleted,
  SlackSocketMessageEdited,
} from "./types.js";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export function parseSlackSocketEvent(
  body: unknown,
  identity: SlackIdentity,
): Exclude<SlackSocketEvent, SlackSocketAction> | undefined {
  if (!isRecord(body) || body.type !== "event_callback" || !nonemptyString(body.event_id)) {
    return undefined;
  }
  const event = body.event;
  if (!isRecord(event)) {
    return undefined;
  }
  const lifecycle = parseLifecycleEvent(body, event, identity);
  if (lifecycle !== undefined) return lifecycle;
  if (event.type !== "message" && event.type !== "app_mention") return undefined;
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

  const message: Mutable<SlackSocketMessage> = {
    eventId: body.event_id,
    type: event.type,
    teamId,
    channelId: event.channel,
    channelType,
    timestamp: event.ts,
    senderId,
    senderBot:
      isSlackId(event.bot_id) || isSlackId(event.app_id) || senderId === identity.botUserId,
    text: event.text,
    files,
    botUserId: identity.botUserId,
  };
  if (threadTimestamp !== undefined) message.threadTimestamp = threadTimestamp;
  if (senderDisplayName !== undefined) message.senderDisplayName = senderDisplayName;
  return message;
}

function parseLifecycleEvent(
  body: Record<string, unknown>,
  event: Record<string, unknown>,
  identity: SlackIdentity,
): Exclude<SlackSocketEvent, SlackSocketAction | SlackSocketMessage> | undefined {
  const teamId = isSlackId(body.team_id) ? body.team_id : identity.teamId;
  if (event.type === "reaction_added" || event.type === "reaction_removed") {
    const item = event.item;
    if (
      !isRecord(item) ||
      item.type !== "message" ||
      !isSlackId(item.channel) ||
      !isSlackTimestamp(item.ts) ||
      !isSlackId(event.user) ||
      !nonemptyString(event.reaction)
    ) {
      return undefined;
    }
    return {
      type: "reaction",
      eventId: body.event_id as string,
      teamId,
      channelId: item.channel,
      channelType: slackChannelType(undefined, item.channel),
      messageTimestamp: item.ts,
      senderId: event.user,
      reaction: event.reaction,
      removed: event.type === "reaction_removed",
      botUserId: identity.botUserId,
    };
  }
  if (event.type !== "message" || !isSlackId(event.channel)) return undefined;
  if (event.subtype === "message_deleted") {
    if (!isSlackTimestamp(event.deleted_ts)) return undefined;
    const previous = isRecord(event.previous_message) ? event.previous_message : undefined;
    const threadTimestamp =
      previous !== undefined && isSlackTimestamp(previous.thread_ts)
        ? previous.thread_ts
        : undefined;
    const deleted: Mutable<SlackSocketMessageDeleted> = {
      type: "message-deleted",
      eventId: body.event_id as string,
      teamId,
      channelId: event.channel,
      channelType: slackChannelType(event.channel_type, event.channel),
      messageTimestamp: event.deleted_ts,
      botUserId: identity.botUserId,
    };
    if (threadTimestamp !== undefined) deleted.threadTimestamp = threadTimestamp;
    return deleted;
  }
  if (event.subtype !== "message_changed" || !isRecord(event.message)) return undefined;
  const message = event.message;
  if (!isSlackTimestamp(message.ts) || typeof message.text !== "string") return undefined;
  const files = slackFiles(message.files);
  if (files === undefined) return undefined;
  const senderId = isSlackId(message.user)
    ? message.user
    : isSlackId(message.bot_id)
      ? message.bot_id
      : undefined;
  if (senderId === undefined) return undefined;
  const threadTimestamp = isSlackTimestamp(message.thread_ts) ? message.thread_ts : undefined;
  const senderDisplayName = displayName(message.user_profile);
  const edited: Mutable<SlackSocketMessageEdited> = {
    type: "message-edited",
    eventId: body.event_id as string,
    teamId,
    channelId: event.channel,
    channelType: slackChannelType(event.channel_type, event.channel),
    messageTimestamp: message.ts,
    senderId,
    senderBot:
      isSlackId(message.bot_id) || isSlackId(message.app_id) || senderId === identity.botUserId,
    text: message.text,
    files,
    botUserId: identity.botUserId,
  };
  if (threadTimestamp !== undefined) edited.threadTimestamp = threadTimestamp;
  if (senderDisplayName !== undefined) edited.senderDisplayName = senderDisplayName;
  return edited;
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
  const action: Mutable<SlackSocketAction> = {
    type: "action",
    eventId,
    teamId: team.id,
    channelId: channel.id,
    channelType: slackChannelType(channel.type, channel.id),
    messageTimestamp: message.ts,
    senderId: user.id,
    actionId: actions[0].value,
    actionTimestamp: actions[0].action_ts,
    botUserId: identity.botUserId,
  };
  if (threadTimestamp !== undefined) action.threadTimestamp = threadTimestamp;
  if (nonemptyString(user.name)) action.senderDisplayName = user.name;
  return action;
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
    const file: Mutable<SlackFile> = {
      id: candidate.id,
      name: nonemptyString(candidate.name) ? candidate.name : candidate.id,
      mediaType: nonemptyString(candidate.mimetype)
        ? candidate.mimetype
        : "application/octet-stream",
      privateDownloadUrl,
    };
    if (candidate.size !== undefined) file.size = Number(candidate.size);
    files.push(file);
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
