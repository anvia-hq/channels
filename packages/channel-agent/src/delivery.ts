import { PartialDeliveryError, sendChannelMessage, validateChannelMessage } from "@anvia/channel";
import type {
  Channel,
  ChannelAddress,
  ChannelEvent,
  ChannelMessage,
  ChannelMessageEvent,
  SentChannelMessage,
} from "@anvia/channel";
import { INTERRUPTED_MESSAGE, eventAddress } from "./options.js";
import type { ChannelAgentErrorContext } from "./types.js";

export type ErrorReporter<RawEvent> = (
  error: unknown,
  context: ChannelAgentErrorContext<RawEvent>,
) => Promise<void>;

export function supportsMessageEdits<RawEvent>(channel: Channel<RawEvent>): boolean {
  return channel.edit !== undefined && channel.capabilities?.messageEdits !== false;
}

export function supportsMessageDelete<RawEvent>(channel: Channel<RawEvent>): boolean {
  return channel.delete !== undefined && channel.capabilities?.delete !== false;
}

export function messageParts<RawEvent>(
  channel: Channel<RawEvent>,
  message: ChannelMessage,
): readonly ChannelMessage[] {
  const parts = channel.splitMessage(message);

  if (parts.length === 0) {
    throw new Error("Channel splitMessage must return at least one message");
  }

  return parts;
}

export async function deliverChannelResponse<RawEvent>(
  request: Readonly<{
    channel: Channel<RawEvent>;
    address: ChannelAddress;
    event: ChannelEvent<RawEvent>;
    provisional: SentChannelMessage | undefined;
    response: string | ChannelMessage;
    deliveredText?: string;
    reportError: ErrorReporter<RawEvent>;
  }>,
): Promise<void> {
  const { channel, address, event, provisional, response, deliveredText, reportError } = request;
  const message = typeof response === "string" ? { text: response } : response;

  if (message.text.length === 0 && message.attachments === undefined) return;

  if (provisional === undefined) {
    await sendChannelMessage({ channel, address, message });
    return;
  }

  if (message.attachments !== undefined) {
    if (!supportsMessageDelete(channel) || channel.delete === undefined) {
      throw new Error("Attachment delivery with a placeholder requires channel deletion support");
    }

    const deleteMessage = channel.delete;
    try {
      await sendChannelMessage({ channel, address, message });
    } catch (error) {
      try {
        await deleteMessage.call(channel, provisional);
      } catch (deleteError) {
        await reportError(deleteError, { stage: "delivery", event });
      }
      throw error;
    }
    await deleteMessage.call(channel, provisional);
    return;
  }

  validateChannelMessage(message);
  const parts = messageParts(channel, message);
  const first = parts[0];

  if (first === undefined) {
    throw new Error("Channel splitMessage must return at least one message");
  }

  const edit = supportsMessageEdits(channel) ? channel.edit : undefined;
  const needsEdit = first.text !== deliveredText || first.actions !== undefined;

  if (needsEdit && edit !== undefined) {
    await edit.call(channel, provisional, first);
  }

  const sent: SentChannelMessage[] = [provisional];
  for (const [offset, part] of parts.slice(1).entries()) {
    try {
      sent.push(await channel.send(address, part));
    } catch (error) {
      throw new PartialDeliveryError({
        sent,
        failedPart: part,
        failedIndex: offset + 1,
        cause: error,
      });
    }
  }
}

export async function sendPlaceholder<RawEvent>(
  request: Readonly<{
    channel: Channel<RawEvent>;
    address: ChannelAddress;
    event: ChannelEvent<RawEvent>;
    placeholder: string | false;
    reportError: ErrorReporter<RawEvent>;
  }>,
): Promise<SentChannelMessage | undefined | null> {
  const { channel, address, event, placeholder, reportError } = request;

  if (channel.capabilities?.typing === true) {
    try {
      await channel.showTyping?.(address);
    } catch (error) {
      await reportError(error, { stage: "delivery", event });
    }
  }

  if (placeholder === false || !supportsMessageEdits(channel)) return undefined;

  if (channel.capabilities?.outboundAttachments !== undefined && !supportsMessageDelete(channel)) {
    return undefined;
  }

  try {
    const first = messageParts(channel, { text: placeholder })[0];

    if (first === undefined) {
      throw new Error("Channel splitMessage must return at least one message");
    }

    return await channel.send(address, first);
  } catch (error) {
    await reportError(error, { stage: "delivery", event });
    return null;
  }
}

export async function cleanupPlaceholder<RawEvent>(
  channel: Channel<RawEvent>,
  provisional: SentChannelMessage | undefined,
): Promise<void> {
  if (provisional === undefined) return;

  if (supportsMessageDelete(channel) && channel.delete !== undefined) {
    try {
      await channel.delete(provisional);
      return;
    } catch {}
  }

  if (!supportsMessageEdits(channel) || channel.edit === undefined) return;

  try {
    await channel.edit(provisional, { text: INTERRUPTED_MESSAGE });
  } catch {}
}

export async function reactToEvent<RawEvent>(
  request: Readonly<{
    channel: Channel<RawEvent>;
    event: ChannelMessageEvent<RawEvent>;
    reaction: string;
    signal: AbortSignal;
    reportError: ErrorReporter<RawEvent>;
  }>,
): Promise<void> {
  const { channel, event, reaction, signal, reportError } = request;

  if (signal.aborted) return;

  if (channel.capabilities?.reactions !== true || channel.react === undefined) return;

  const sent: SentChannelMessage = { id: event.id, address: eventAddress(event) };
  try {
    await channel.react(sent, reaction);
  } catch (error) {
    await reportError(error, { stage: "acknowledge", event });
  }
}

export async function unreactFromEvent<RawEvent>(
  request: Readonly<{
    channel: Channel<RawEvent>;
    event: ChannelMessageEvent<RawEvent>;
    reaction: string;
    signal: AbortSignal;
    reportError: ErrorReporter<RawEvent>;
  }>,
): Promise<void> {
  const { channel, event, reaction, signal, reportError } = request;

  if (signal.aborted) return;

  if (channel.capabilities?.reactionRemovals !== true || channel.unreact === undefined) return;

  const sent: SentChannelMessage = { id: event.id, address: eventAddress(event) };
  try {
    await channel.unreact(sent, reaction);
  } catch (error) {
    await reportError(error, { stage: "acknowledge", event });
  }
}
