import type { Channel, ChannelAddress, ChannelMessage, SentChannelMessage } from "./types.js";

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
