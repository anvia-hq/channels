import { describe, expect, it } from "vitest";
import { createRateLimitedChannel } from "../src/index.js";
import type {
  Channel,
  ChannelAddress,
  ChannelEventHandler,
  ChannelMessage,
  SentChannelMessage,
} from "@anvia/channel";

class RecordingChannel implements Channel {
  readonly platform = "test";
  readonly capabilities = { actions: true, reactions: true, reactionRemovals: true } as const;
  readonly sent: ChannelMessage[] = [];
  readonly callTimes: number[] = [];
  private handler: ChannelEventHandler | undefined;

  splitMessage(message: ChannelMessage): readonly ChannelMessage[] {
    return [message];
  }

  async start(handler: ChannelEventHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {}

  async emit(event: Parameters<ChannelEventHandler>[0]): Promise<void> {
    if (this.handler === undefined) throw new Error("not running");
    await this.handler(event);
  }

  async send(_address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage> {
    this.callTimes.push(Date.now());
    this.sent.push(message);
    return { id: String(this.sent.length), address: _address };
  }

  async react(): Promise<void> {
    this.callTimes.push(Date.now());
  }
}

describe("createRateLimitedChannel", () => {
  it("rejects nonpositive intervals", () => {
    const channel = new RecordingChannel();
    expect(() => createRateLimitedChannel({ channel, minimumIntervalMs: 0 })).toThrow(TypeError);
  });

  it("spaces outbound calls at least the configured interval apart", async () => {
    const inner = new RecordingChannel();
    const channel = createRateLimitedChannel({ channel: inner, minimumIntervalMs: 25 });
    const address = { platform: "test", conversationId: "c1" };

    await channel.start(async () => undefined);
    const sent = await channel.send(address, { text: "one" });
    await channel.send(address, { text: "two" });
    await channel.react?.(sent, "👍");

    expect(inner.callTimes).toHaveLength(3);
    const [first, second, third] = inner.callTimes;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("expected three paced calls");
    }
    expect(second - first).toBeGreaterThanOrEqual(20);
    expect(third - second).toBeGreaterThanOrEqual(20);
    await channel.stop();
  });

  it("passes inbound behaviour and capabilities through", async () => {
    const inner = new RecordingChannel();
    const channel = createRateLimitedChannel({ channel: inner, minimumIntervalMs: 25 });
    expect(channel.platform).toBe("test");
    expect(channel.capabilities?.reactions).toBe(true);
    await channel.start(async () => undefined);
    await inner.emit({
      type: "message",
      id: "1",
      platform: "test",
      conversation: { id: "c1", kind: "direct" },
      sender: { id: "u1", bot: false },
      text: "hi",
      attachments: [],
      mentionedBot: false,
      raw: {},
    });
    await channel.stop();
    expect(inner.sent).toEqual([]);
  });
});
