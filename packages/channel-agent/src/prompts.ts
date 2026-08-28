import type { AgentPrompt, UserContentPart } from "@anvia/core";
import type {
  Channel,
  ChannelAttachment,
  ChannelAttachmentData,
  ChannelMessageEvent,
} from "@anvia/channel";
import type { ChannelAgentMultimodalOptions } from "./types.js";

const DEFAULT_MAXIMUM_ATTACHMENTS = 10;
const DEFAULT_MAXIMUM_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAXIMUM_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const DEFAULT_ATTACHMENT_CONCURRENCY = 2;

export type ChannelMessagePromptOptions = ChannelAgentMultimodalOptions &
  Readonly<{ signal?: AbortSignal }>;

export async function channelMessagePrompt<RawEvent>(
  channel: Channel<RawEvent>,
  event: ChannelMessageEvent<RawEvent>,
  options: ChannelMessagePromptOptions = {},
): Promise<AgentPrompt> {
  if (event.attachments.length === 0) return event.text;

  const policy = resolveMultimodalOptions(options);
  validateAttachmentMetadata(event.attachments, policy);
  const loadAttachment = channel.loadAttachment;
  if (loadAttachment === undefined) {
    throw new TypeError(`Channel ${channel.platform} does not support attachment loading`);
  }

  const content: UserContentPart[] = [];
  if (event.text.length > 0) content.push({ type: "text", text: event.text });
  const data = await loadAttachments(
    event.attachments,
    policy.attachmentConcurrency,
    async (attachment) => loadAttachment.call(channel, event, attachment, options.signal),
    policy,
  );
  for (const [index, attachment] of event.attachments.entries()) {
    const attachmentData = data[index];
    if (attachmentData === undefined) throw new Error(`Channel attachment ${index} was not loaded`);
    if (attachment.type === "image") {
      content.push({
        type: "image",
        image: attachmentData,
        mediaType: attachment.mediaType,
      });
      continue;
    }
    content.push({
      type: "file",
      data: attachmentData,
      mediaType: attachment.mediaType,
      ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
    });
  }
  return { role: "user", content };
}

export function resolveMultimodalOptions(
  options: ChannelAgentMultimodalOptions = {},
): Required<ChannelAgentMultimodalOptions> {
  const policy = {
    maximumAttachments: options.maximumAttachments ?? DEFAULT_MAXIMUM_ATTACHMENTS,
    maximumAttachmentBytes: options.maximumAttachmentBytes ?? DEFAULT_MAXIMUM_ATTACHMENT_BYTES,
    maximumTotalAttachmentBytes:
      options.maximumTotalAttachmentBytes ?? DEFAULT_MAXIMUM_TOTAL_ATTACHMENT_BYTES,
    attachmentConcurrency: options.attachmentConcurrency ?? DEFAULT_ATTACHMENT_CONCURRENCY,
  };
  positiveInteger(policy.maximumAttachments, "maximum attachment count");
  positiveInteger(policy.maximumAttachmentBytes, "maximum attachment size");
  positiveInteger(policy.maximumTotalAttachmentBytes, "maximum total attachment size");
  positiveInteger(policy.attachmentConcurrency, "attachment concurrency");
  return policy;
}

function validateAttachmentMetadata(
  attachments: readonly ChannelAttachment[],
  policy: Required<ChannelAgentMultimodalOptions>,
): void {
  if (attachments.length > policy.maximumAttachments) {
    throw new RangeError(
      `Channel prompt must not contain more than ${policy.maximumAttachments} attachments`,
    );
  }

  let knownTotal = 0;
  for (const attachment of attachments) {
    if (attachment.size === undefined) continue;
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw new TypeError("Channel attachment size must be a nonnegative integer");
    }
    if (attachment.size > policy.maximumAttachmentBytes) {
      throw new RangeError(
        `Channel attachment must not exceed ${policy.maximumAttachmentBytes} bytes`,
      );
    }
    knownTotal += attachment.size;
    if (knownTotal > policy.maximumTotalAttachmentBytes) {
      throw new RangeError(
        `Channel attachments must not exceed ${policy.maximumTotalAttachmentBytes} bytes in total`,
      );
    }
  }
}

async function loadAttachments(
  attachments: readonly ChannelAttachment[],
  concurrency: number,
  load: (attachment: ChannelAttachment) => Promise<ChannelAttachmentData>,
  policy: Required<ChannelAgentMultimodalOptions>,
): Promise<readonly ChannelAttachmentData[]> {
  const result: ChannelAttachmentData[] = Array.from({ length: attachments.length });
  let nextIndex = 0;
  let totalBytes = 0;
  let failure: unknown;

  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = nextIndex;
      if (index >= attachments.length) return;
      nextIndex += 1;
      const attachment = attachments[index];
      if (attachment === undefined) return;

      try {
        const loaded = await load(attachment);
        const bytes = attachmentDataBytes(loaded, attachment, policy.maximumAttachmentBytes);
        totalBytes += bytes;
        if (totalBytes > policy.maximumTotalAttachmentBytes) {
          throw new RangeError(
            `Channel attachments must not exceed ${policy.maximumTotalAttachmentBytes} bytes in total`,
          );
        }
        result[index] = loaded;
      } catch (error) {
        failure = error;
      }
    }
  };

  const workerCount = Math.min(concurrency, attachments.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (failure !== undefined) throw failure;
  return result;
}

function attachmentDataBytes(
  data: ChannelAttachmentData,
  attachment: ChannelAttachment,
  maximumBytes: number,
): number {
  if (data.type === "url") {
    if (attachment.size === undefined) {
      throw new TypeError("URL-backed channel attachments must include their byte size");
    }
    return attachment.size;
  }

  const bytes = base64Bytes(data.data, maximumBytes);
  if (bytes > maximumBytes) {
    throw new RangeError(`Channel attachment must not exceed ${maximumBytes} bytes`);
  }
  return bytes;
}

function base64Bytes(value: string, maximumBytes: number): number {
  const maximumCharacters = Math.ceil(maximumBytes / 3) * 4;
  if (value.length > maximumCharacters) return maximumBytes + 1;
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)
  ) {
    throw new TypeError("Channel attachment data must be valid base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Channel agent ${label} must be a positive integer`);
  }
}
