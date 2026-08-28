import { describe, expect, it, vi } from "vitest";
import {
  sendChannelMessage,
  splitChannelMessage,
  splitChannelText,
  validateChannelActions,
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

    const parts = splitChannelText(text, 12);

    expect(parts.every((part) => part.length <= 12)).toBe(true);
    expect(parts.join("")).toBe(text);
  });

  it("places actions only on the final split message", () => {
    expect(
      splitChannelMessage(
        { text: "abcdefgh", actions: [{ id: "approve", label: "Approve", style: "primary" }] },
        3,
      ),
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

  it("does not split a surrogate pair", () => {
    expect(splitChannelText("1234😀6789", 5)).toEqual(["1234", "😀678", "9"]);
    expect(() => splitChannelText("😀", 1)).toThrow("cannot preserve a Unicode character");
  });

  it("sends every platform-prepared message part in order", async () => {
    const channel = new SplittingChannel(5);
    const address = { platform: "test", conversationId: "conversation" };

    const sent = await sendChannelMessage(channel, address, { text: "abcdefghijk" });

    expect(channel.send).toHaveBeenCalledTimes(3);
    expect(channel.send.mock.calls.map((call) => call[1].text)).toEqual(["abcde", "fghij", "k"]);
    expect(sent.map((message) => message.id)).toEqual(["1", "2", "3"]);
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
    return splitChannelText(message.text, this.maximumLength).map((text) => ({ text }));
  }

  async start(_handler: ChannelEventHandler): Promise<void> {}
  async stop(): Promise<void> {}
  async edit(_sent: SentChannelMessage, _message: ChannelMessage): Promise<void> {}
}
