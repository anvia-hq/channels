import type { ChannelActionStyle, ChannelMessage } from "@anvia/channel";
import { isRecord, readBoundedResponseBuffer } from "@anvia/channel/adapter";
import type {
  APIActionRowComponent,
  APIButtonComponentWithCustomId,
  InteractionEditReplyOptions,
} from "discord.js";
import { isDiscordSnowflake } from "./snowflake.js";
import type { DiscordGatewaySentMessage } from "./types.js";

export type RestRequest = Readonly<{
  body?: unknown;
  files?: { data: Buffer; name: string }[];
}>;

export type DiscordRestClient = Readonly<{
  post(route: `/${string}`, options?: RestRequest): Promise<unknown>;
  patch(route: `/${string}`, options?: RestRequest): Promise<unknown>;
  delete(route: `/${string}`): Promise<unknown>;
  put(route: `/${string}`): Promise<unknown>;
}>;

export function messageBody(message: ChannelMessage): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    content: message.text,
    allowed_mentions: { parse: [] },
    components: messageComponents(message),
  };

  if (message.replyToMessageId !== undefined) {
    body.message_reference = { message_id: message.replyToMessageId };
  }

  return body;
}

export function interactionReplyPayload(message: ChannelMessage): InteractionEditReplyOptions {
  return {
    content: message.text,
    allowedMentions: { parse: [] },
    components: messageComponents(message),
  };
}

export async function discordFiles(
  message: ChannelMessage,
  fetchImplementation: typeof globalThis.fetch,
  maximumBytes: number,
): Promise<{ data: Buffer; name: string }[]> {
  if (message.attachments === undefined) return [];

  const files: { data: Buffer; name: string }[] = [];
  let totalBytes = 0;
  for (const [index, attachment] of message.attachments.entries()) {
    if (attachment.size !== undefined && attachment.size > maximumBytes) {
      throw new RangeError(`Discord attachment must not exceed ${maximumBytes} bytes`);
    }

    const data =
      attachment.source.type === "data"
        ? boundedBase64(attachment.source.data, maximumBytes)
        : await downloadAttachment(attachment.source.url, fetchImplementation, maximumBytes);
    totalBytes += data.byteLength;

    if (totalBytes > maximumBytes) {
      throw new RangeError(`Discord attachments must not exceed ${maximumBytes} bytes in total`);
    }

    files.push({ data, name: attachment.filename ?? `attachment-${index + 1}` });
  }
  return files;
}

export function sentMessage(value: unknown): DiscordGatewaySentMessage {
  if (!isRecord(value) || !isDiscordSnowflake(value.id) || !isDiscordSnowflake(value.channel_id)) {
    throw new TypeError("Discord create-message response is invalid");
  }

  return { id: value.id, channelId: value.channel_id };
}

function buttonStyle(style: ChannelActionStyle | undefined): 1 | 2 | 4 {
  if (style === "primary") return 1;

  if (style === "danger") return 4;

  return 2;
}

function messageComponents(
  message: ChannelMessage,
): readonly APIActionRowComponent<APIButtonComponentWithCustomId>[] {
  if (message.actions === undefined) return [];

  return [
    {
      type: 1,
      components: message.actions.map((action) => ({
        type: 2,
        style: buttonStyle(action.style),
        label: action.label,
        custom_id: action.id,
      })),
    },
  ];
}

function boundedBase64(data: string, maximumBytes: number): Buffer {
  const buffer = Buffer.from(data, "base64");

  if (buffer.byteLength > maximumBytes) {
    throw new RangeError(`Discord attachment must not exceed ${maximumBytes} bytes`);
  }

  return buffer;
}

async function downloadAttachment(
  url: string,
  fetchImplementation: typeof globalThis.fetch,
  maximumBytes: number,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImplementation(url, { redirect: "error" });
  } catch {
    throw new Error("Discord attachment download failed");
  }

  if (!response.ok) {
    throw new Error(`Discord attachment download failed with HTTP ${response.status}`);
  }

  return readBoundedResponseBuffer(response, {
    maximumBytes,
    label: "Discord attachment",
  });
}
