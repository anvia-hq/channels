import { vi } from "vitest";
import type { SlackSocketMessage, SlackTransport, SlackTransportHandler } from "../src/index.js";

export type FakeSlackTransport = Readonly<{
  transport: SlackTransport;
  start: ReturnType<typeof vi.fn<SlackTransport["start"]>>;
  stop: ReturnType<typeof vi.fn<SlackTransport["stop"]>>;
  send: ReturnType<typeof vi.fn<SlackTransport["send"]>>;
  edit: ReturnType<typeof vi.fn<SlackTransport["edit"]>>;
  emit(message: SlackSocketMessage): Promise<void>;
}>;

export function fakeTransport(): FakeSlackTransport {
  let handler: SlackTransportHandler | undefined;
  const start = vi.fn<SlackTransport["start"]>(async (nextHandler) => {
    handler = nextHandler;
  });
  const stop = vi.fn<SlackTransport["stop"]>(async () => undefined);
  const send = vi.fn<SlackTransport["send"]>(async (channelId, threadTimestamp) => ({
    channelId,
    timestamp: "1700000001.000002",
    ...(threadTimestamp === undefined ? {} : { threadTimestamp }),
  }));
  const edit = vi.fn<SlackTransport["edit"]>(async () => undefined);

  return {
    transport: { start, stop, send, edit },
    start,
    stop,
    send,
    edit,
    async emit(message) {
      if (handler === undefined) throw new Error("Fake Slack transport is not running");
      await handler(message);
    },
  };
}

export function slackMessage(overrides: Partial<SlackSocketMessage> = {}): SlackSocketMessage {
  return {
    eventId: "Ev1",
    type: "app_mention",
    teamId: "T1",
    channelId: "C1",
    channelType: "channel",
    timestamp: "1700000000.000001",
    senderId: "U1",
    senderDisplayName: "Indra",
    senderBot: false,
    text: "hello <@U2>",
    botUserId: "U2",
    ...overrides,
  };
}
