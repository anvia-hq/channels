import type { Channel, ChannelAddress, ChannelMessage, SentChannelMessage } from "./types.js";

export const MAX_CHANNEL_ACTIONS = 5;
export const MAX_CHANNEL_ACTION_ID_BYTES = 64;
export const MAX_CHANNEL_ACTION_LABEL_LENGTH = 80;

export function splitChannelText(text: string, maximumLength: number): readonly string[] {
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError("Channel message text must not be empty");
  }
  if (!Number.isSafeInteger(maximumLength) || maximumLength <= 0) {
    throw new TypeError("Channel message maximum length must be a positive integer");
  }

  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= maximumLength) {
      parts.push(text.slice(start));
      break;
    }

    const maximumEnd = start + maximumLength;
    const preferredEnd = readableBoundary(text, start, maximumEnd);
    const end = safeCodePointBoundary(text, start, preferredEnd);
    if (end <= start) {
      throw new RangeError("Channel message maximum length cannot preserve a Unicode character");
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

export function splitChannelMessage(
  message: ChannelMessage,
  maximumLength: number,
): readonly ChannelMessage[] {
  const textParts = splitChannelText(message.text, maximumLength);
  return textParts.map((text, index) => ({
    text,
    ...(index === textParts.length - 1 && message.actions !== undefined
      ? { actions: message.actions }
      : {}),
  }));
}

export function validateChannelActions(actions: readonly unknown[] | undefined): void {
  if (actions === undefined) return;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new TypeError("Channel message actions must be a non-empty array");
  }
  if (actions.length > MAX_CHANNEL_ACTIONS) {
    throw new RangeError(
      `Channel message must not contain more than ${MAX_CHANNEL_ACTIONS} actions`,
    );
  }

  const identifiers = new Set<string>();
  for (const value of actions) {
    if (!isRecord(value)) throw new TypeError("Channel message action must be an object");
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new TypeError("Channel message action ID must not be empty");
    }
    if (!isChannelActionId(value.id)) {
      throw new RangeError(
        `Channel message action ID must not exceed ${MAX_CHANNEL_ACTION_ID_BYTES} UTF-8 bytes`,
      );
    }
    if (identifiers.has(value.id)) {
      throw new TypeError("Channel message action IDs must be unique");
    }
    identifiers.add(value.id);
    if (
      typeof value.label !== "string" ||
      value.label.length === 0 ||
      value.label.length > MAX_CHANNEL_ACTION_LABEL_LENGTH
    ) {
      throw new RangeError(
        `Channel message action label must contain between 1 and ${MAX_CHANNEL_ACTION_LABEL_LENGTH} characters`,
      );
    }
    if (
      value.style !== undefined &&
      value.style !== "default" &&
      value.style !== "primary" &&
      value.style !== "danger"
    ) {
      throw new TypeError("Channel message action style is invalid");
    }
  }
}

export function isChannelActionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CHANNEL_ACTION_ID_BYTES
  );
}

export async function sendChannelMessage<RawEvent>(
  channel: Channel<RawEvent>,
  address: ChannelAddress,
  message: ChannelMessage,
): Promise<readonly SentChannelMessage[]> {
  const sent: SentChannelMessage[] = [];
  for (const part of channel.splitMessage(message)) {
    sent.push(await channel.send(address, part));
  }
  if (sent.length === 0) {
    throw new Error("Channel splitMessage must return at least one message");
  }
  return sent;
}

function readableBoundary(text: string, start: number, maximumEnd: number): number {
  const candidate = text.slice(start, maximumEnd);
  const newline = candidate.lastIndexOf("\n");
  if (newline >= 0) return start + newline + 1;

  const space = candidate.lastIndexOf(" ");
  if (space >= 0) return start + space + 1;
  return maximumEnd;
}

function safeCodePointBoundary(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  const splitsSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return splitsSurrogatePair ? end - 1 : end;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
