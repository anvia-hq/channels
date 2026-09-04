import { describe, expect, it, vi } from "vitest";
import {
  PartialDeliveryError,
  isChannelActionId,
  sendChannelMessage,
  splitChannelMessage,
  splitChannelText,
  validateChannelActions,
  validateChannelAttachments,
  validateChannelMessage,
} from "../src/index.js";
import type {
  Channel,
  ChannelAddress,
  ChannelEventHandler,
  ChannelMessage,
  SentChannelMessage,
} from "../src/index.js";

describe("channel message delivery", () => {
  it("splits text at readable boundaries without changing its contents", () => {
    const text = "first line\nsecond line is longer";

    const parts = splitChannelText({ text, maximumLength: 12 });

    expect(parts.every((part) => part.length <= 12)).toBe(true);
    expect(parts.join("")).toBe(text);
  });

  it("places actions only on the final split message", () => {
    expect(
      splitChannelMessage({
        message: {
          text: "abcdefgh",
          actions: [{ id: "approve", label: "Approve", style: "primary" }],
        },
        maximumLength: 3,
      }),
    ).toEqual([
      { text: "abc" },
      { text: "def" },
      { text: "gh", actions: [{ id: "approve", label: "Approve", style: "primary" }] },
    ]);
  });

  it("validates the portable action limits", () => {
    expect(() =>
      validateChannelActions([
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny", style: "danger" },
      ]),
    ).not.toThrow();
    expect(() => validateChannelActions([])).toThrow("non-empty array");
    expect(() =>
      validateChannelActions([
        { id: "same", label: "First" },
        { id: "same", label: "Second" },
      ]),
    ).toThrow("must be unique");
    expect(() => validateChannelActions([{ id: "x".repeat(65), label: "Too long" }])).toThrow(
      "64 UTF-8 bytes",
    );
  });

  it("validates outbound attachments and keeps them on the final part", () => {
    const attachment = {
      type: "file" as const,
      mediaType: "application/pdf",
      filename: "report.pdf",
      source: { type: "data" as const, data: "cGRm" },
    };

    expect(() => validateChannelAttachments([attachment])).not.toThrow();
    expect(
      splitChannelMessage({
        message: {
          text: "abcdef",
          replyToMessageId: "message-1",
          attachments: [attachment],
        },
        maximumLength: 3,
      }),
    ).toEqual([
      { text: "abc", replyToMessageId: "message-1" },
      { text: "def", replyToMessageId: "message-1", attachments: [attachment] },
    ]);
    expect(
      splitChannelMessage({ message: { text: "", attachments: [attachment] }, maximumLength: 3 }),
    ).toEqual([{ text: "", attachments: [attachment] }]);
    expect(() =>
      validateChannelAttachments([
        { ...attachment, source: { type: "url", url: "http://insecure.example/report.pdf" } },
      ]),
    ).toThrow("must use HTTPS");
    expect(() =>
      validateChannelAttachments([{ ...attachment, source: { type: "data", data: "***" } }]),
    ).toThrow("valid base64");
    for (const data of ["==", "A=", "AA="]) {
      expect(() =>
        validateChannelAttachments([{ ...attachment, source: { type: "data", data } }]),
      ).toThrow("valid base64");
    }
    for (const data of ["Zg", "Zg==", "Zm8", "Zm8=", "Zm9v"]) {
      expect(() =>
        validateChannelAttachments([{ ...attachment, source: { type: "data", data } }]),
      ).not.toThrow();
    }
  });

  it("does not split a surrogate pair", () => {
    expect(splitChannelText({ text: "1234😀6789", maximumLength: 5 })).toEqual([
      "1234",
      "😀678",
      "9",
    ]);
    expect(() => splitChannelText({ text: "😀", maximumLength: 1 })).toThrow(
      "cannot preserve a Unicode character",
    );
  });

  it("sends every platform-prepared message part in order", async () => {
    const channel = new SplittingChannel(5);
    const address = { platform: "test", conversationId: "conversation" };
    const sent = await sendChannelMessage({
      channel,
      address,
      message: { text: "abcdefghijk" },
    });

    expect(channel.send).toHaveBeenCalledTimes(3);
    expect(channel.send.mock.calls.map((call) => call[1].text)).toEqual(["abcde", "fghij", "k"]);
    expect(sent.map((message) => message.id)).toEqual(["1", "2", "3"]);
  });
});

describe("channel message delivery edges", () => {
  const address: ChannelAddress = { platform: "test", conversationId: "c1" };

  it("rejects empty text and invalid maximum lengths", () => {
    expect(() => splitChannelText({ text: "", maximumLength: 10 })).toThrow(/empty/);
    expect(() => splitChannelText({ text: "hello", maximumLength: 0 })).toThrow(TypeError);
    expect(() => splitChannelText({ text: "hello", maximumLength: -5 })).toThrow(TypeError);
    expect(() => splitChannelText({ text: "hello", maximumLength: 2.5 })).toThrow(TypeError);
  });

  it("keeps text unchanged when it already fits", () => {
    expect(splitChannelText({ text: "abcdefghij", maximumLength: 10 })).toEqual(["abcdefghij"]);
  });

  it("prefers newline boundaries over spaces", () => {
    expect(splitChannelText({ text: "one\ntwo three", maximumLength: 9 })).toEqual([
      "one\n",
      "two three",
    ]);
  });

  it("throws when a single character cannot fit", () => {
    expect(() => splitChannelText({ text: "a🇺🇸b", maximumLength: 1 })).toThrow(RangeError);
  });

  it("enforces the action id byte limit in UTF-8", () => {
    expect(isChannelActionId("a".repeat(64))).toBe(true);
    expect(isChannelActionId("a".repeat(65))).toBe(false);
    expect(isChannelActionId("é".repeat(32))).toBe(true);
    expect(isChannelActionId("é".repeat(33))).toBe(false);
    expect(isChannelActionId("")).toBe(false);
  });

  it("reports partial delivery state when a later part fails", async () => {
    const cause = new Error("platform down");
    let calls = 0;
    const channel = {
      platform: "test",
      splitMessage: (message: ChannelMessage) =>
        splitChannelText({ text: message.text, maximumLength: 5 }).map((text) => ({ text })),
      async start(): Promise<void> {},
      async stop(): Promise<void> {},
      async edit(): Promise<void> {},
      async send(): Promise<SentChannelMessage> {
        calls += 1;
        if (calls === 2) throw cause;
        return { id: String(calls), address };
      },
    } satisfies Channel;

    const failure = await sendChannelMessage({
      channel,
      address,
      message: { text: "abcdefghij" },
    }).catch((error: unknown) => error);
    if (!(failure instanceof PartialDeliveryError)) throw new Error("Expected partial failure");

    expect(failure.sent).toEqual([{ id: "1", address }]);
    expect(failure.failedIndex).toBe(1);
    expect(failure.failedPart).toEqual({ text: "fghij" });
    expect(failure.cause).toBe(cause);
  });

  it("rejects channels whose splitMessage yields no parts", async () => {
    const channel: Channel = {
      platform: "test",
      splitMessage: () => [],
      async start(): Promise<void> {},
      async stop(): Promise<void> {},
      async edit(): Promise<void> {},
      async send(): Promise<SentChannelMessage> {
        throw new Error("must not send");
      },
    };

    await expect(
      sendChannelMessage({ channel, address, message: { text: "hello" } }),
    ).rejects.toThrow("at least one message");
  });

  it("validates the complete outbound message payload", () => {
    expect(() =>
      validateChannelMessage({ text: "hi", actions: [{ id: "go", label: "Go" }] }),
    ).not.toThrow();
    expect(() => validateChannelMessage({ text: "hi", actions: [] })).toThrow("non-empty array");
    expect(() =>
      validateChannelMessage({
        text: "hi",
        attachments: [
          {
            type: "file",
            mediaType: "text/plain",
            source: { type: "url", url: "http://insecure.example/file" },
          },
        ],
      }),
    ).toThrow(TypeError);
  });
});

class SplittingChannel implements Channel {
  readonly platform = "test";
  readonly send = vi.fn(
    async (address: ChannelAddress, _message: ChannelMessage): Promise<SentChannelMessage> => ({
      id: String(this.send.mock.calls.length),
      address,
    }),
  );

  constructor(private readonly maximumLength: number) {}

  splitMessage(message: ChannelMessage): readonly ChannelMessage[] {
    return splitChannelText({ text: message.text, maximumLength: this.maximumLength }).map(
      (text) => ({ text }),
    );
  }

  async start(_handler: ChannelEventHandler): Promise<void> {}
  async stop(): Promise<void> {}
  async edit(_sent: SentChannelMessage, _message: ChannelMessage): Promise<void> {}
}
