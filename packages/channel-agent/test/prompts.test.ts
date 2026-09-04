import type { Channel, ChannelAttachmentData, ChannelMessageEvent } from "@anvia/channel";
import { describe, expect, it, vi } from "vitest";
import { channelMessagePrompt } from "../src/index.js";
import { messageEvent } from "./helpers.js";

describe("channelMessagePrompt", () => {
  it("limits attachment loading concurrency while preserving prompt order", async () => {
    let active = 0;
    let peak = 0;
    const loadAttachment = vi.fn(async (): Promise<ChannelAttachmentData> => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { type: "data", data: "AQ==" };
    });
    const event = attachmentEvent(4);

    const prompt = await channelMessagePrompt({
      channel: channelWith(loadAttachment),
      event,
      attachmentConcurrency: 2,
    });

    expect(peak).toBe(2);
    expect(loadAttachment).toHaveBeenCalledTimes(4);
    expect(prompt).toEqual({
      role: "user",
      content: [
        { type: "text", text: "hello" },
        ...Array.from({ length: 4 }, () => ({
          type: "file",
          data: { type: "data", data: "AQ==" },
          mediaType: "application/octet-stream",
        })),
      ],
    });
  });

  it("rejects excessive counts and known total sizes before loading", async () => {
    const loadAttachment = vi.fn(async (): Promise<ChannelAttachmentData> => ({
      type: "data",
      data: "AQ==",
    }));
    const channel = channelWith(loadAttachment);

    await expect(
      channelMessagePrompt({
        channel,
        event: attachmentEvent(3),
        maximumAttachments: 2,
      }),
    ).rejects.toThrow("more than 2 attachments");
    await expect(
      channelMessagePrompt({
        channel,
        event: messageEvent({
          attachments: [
            { id: "1", type: "file", mediaType: "text/plain", size: 2 },
            { id: "2", type: "file", mediaType: "text/plain", size: 2 },
          ],
        }),
        maximumTotalAttachmentBytes: 3,
      }),
    ).rejects.toThrow("3 bytes in total");
    expect(loadAttachment).not.toHaveBeenCalled();
  });

  it("enforces actual data size and requires URL-backed attachment sizes", async () => {
    await expect(
      channelMessagePrompt({
        channel: channelWith(async () => ({ type: "data", data: "AQID" })),
        event: attachmentEvent(1),
        maximumAttachmentBytes: 2,
      }),
    ).rejects.toThrow("must not exceed 2 bytes");
    await expect(
      channelMessagePrompt({
        channel: channelWith(async () => ({
          type: "url",
          url: "https://cdn.example.test/file",
        })),
        event: attachmentEvent(1),
      }),
    ).rejects.toThrow("must include their byte size");
  });

  it("reports when a text-only channel receives attachments", async () => {
    await expect(
      channelMessagePrompt({ channel: channelWith(), event: attachmentEvent(1) }),
    ).rejects.toThrow("does not support attachment loading");
  });
});

function attachmentEvent(count: number): ChannelMessageEvent {
  return messageEvent({
    attachments: Array.from({ length: count }, (_, index) => ({
      id: String(index),
      type: "file" as const,
      mediaType: "application/octet-stream",
    })),
  });
}

function channelWith(loadAttachment?: NonNullable<Channel["loadAttachment"]>): Channel {
  const channel: Channel = {
    platform: "test",
    splitMessage: (message) => [message],
    start: async () => undefined,
    stop: async () => undefined,
    send: async (address) => ({ id: "1", address }),
    edit: async () => undefined,
  };
  if (loadAttachment !== undefined) channel.loadAttachment = loadAttachment;
  return channel;
}
