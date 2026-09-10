import type {
  Channel,
  ChannelAddress,
  ChannelEventHandler,
  ChannelMessage,
  SentChannelMessage,
} from "./types.js";

export type RateLimitedChannelOptions = Readonly<{
  channel: Channel;
  /** Minimum spacing in milliseconds between two outbound platform calls. */
  minimumIntervalMs: number;
}>;

/**
 * Wraps a channel so outbound calls (send, edit, delete, typing, reactions)
 * are serialized with at least `minimumIntervalMs` between them. Inbound
 * behaviour (start, stop, loadAttachment, splitMessage) and the advertised
 * capabilities are passed straight through.
 *
 * Discord and Slack SDK clients already rate-limit internally; this wrapper is
 * most useful for raw-REST adapters such as Telegram, or for application code
 * that fan-outs many proactive messages.
 */
export function createRateLimitedChannel(options: RateLimitedChannelOptions): Channel {
  const { channel, minimumIntervalMs } = options;
  if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs <= 0) {
    throw new TypeError("Rate limit minimum interval must be a positive integer");
  }

  let nextSlotAt = Date.now();
  let tail: Promise<void> = Promise.resolve();

  const pace = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(async () => {
      const waitMs = Math.max(0, nextSlotAt - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      nextSlotAt = Date.now() + minimumIntervalMs;
      return task();
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  type MutableChannel = { -readonly [K in keyof Partial<Channel>]: Partial<Channel>[K] } & {
    platform: string;
    splitMessage(message: ChannelMessage): readonly ChannelMessage[];
    start(handler: ChannelEventHandler): Promise<void>;
    stop(): Promise<void>;
    send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage>;
  };
  const wrapped: MutableChannel = {
    platform: channel.platform,
    splitMessage(message) {
      return channel.splitMessage(message);
    },
    start(handler: ChannelEventHandler) {
      return channel.start(handler);
    },
    stop() {
      return channel.stop();
    },
    send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage> {
      return pace(() => channel.send(address, message));
    },
  };
  if (channel.capabilities !== undefined) {
    wrapped.capabilities = channel.capabilities;
  }
  if (channel.loadAttachment !== undefined) {
    const loadAttachment = channel.loadAttachment.bind(channel);
    wrapped.loadAttachment = (event, attachment, signal) =>
      loadAttachment(event, attachment, signal);
  }
  if (channel.edit !== undefined) {
    const edit = channel.edit.bind(channel);
    wrapped.edit = (sent, message) => pace(() => edit(sent, message));
  }
  if (channel.delete !== undefined) {
    const deleteMessage = channel.delete.bind(channel);
    wrapped.delete = (sent) => pace(() => deleteMessage(sent));
  }
  if (channel.showTyping !== undefined) {
    const showTyping = channel.showTyping.bind(channel);
    wrapped.showTyping = (address) => pace(() => showTyping(address));
  }
  if (channel.react !== undefined) {
    const react = channel.react.bind(channel);
    wrapped.react = (sent, reaction) => pace(() => react(sent, reaction));
  }
  if (channel.unreact !== undefined) {
    const unreact = channel.unreact.bind(channel);
    wrapped.unreact = (sent, reaction) => pace(() => unreact(sent, reaction));
  }
  return wrapped satisfies Channel;
}
