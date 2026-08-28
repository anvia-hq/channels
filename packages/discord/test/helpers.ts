import { vi } from "vitest";
import type { DiscordGateway, DiscordGatewayHandler, DiscordGatewayMessage } from "../src/index.js";

export type FakeDiscordGateway = Readonly<{
  gateway: DiscordGateway;
  start: ReturnType<typeof vi.fn<DiscordGateway["start"]>>;
  stop: ReturnType<typeof vi.fn<DiscordGateway["stop"]>>;
  send: ReturnType<typeof vi.fn<DiscordGateway["send"]>>;
  edit: ReturnType<typeof vi.fn<DiscordGateway["edit"]>>;
  emit(message: DiscordGatewayMessage): Promise<void>;
}>;

export function fakeGateway(): FakeDiscordGateway {
  let handler: DiscordGatewayHandler | undefined;
  const start = vi.fn<DiscordGateway["start"]>(async (nextHandler) => {
    handler = nextHandler;
  });
  const stop = vi.fn<DiscordGateway["stop"]>(async () => undefined);
  const send = vi.fn<DiscordGateway["send"]>(async (channelId) => ({
    id: "77",
    channelId,
  }));
  const edit = vi.fn<DiscordGateway["edit"]>(async () => undefined);

  return {
    gateway: { start, stop, send, edit },
    start,
    stop,
    send,
    edit,
    async emit(message) {
      if (handler === undefined) throw new Error("Fake Discord gateway is not running");
      await handler(message);
    },
  };
}

export function discordMessage(
  overrides: Partial<DiscordGatewayMessage> = {},
): DiscordGatewayMessage {
  return {
    id: "10",
    channelId: "20",
    ...(overrides.direct === true ? {} : { guildId: "30" }),
    content: "hello",
    attachments: [],
    author: {
      id: "40",
      username: "indra",
      globalName: "Indra",
      bot: false,
    },
    bot: {
      id: "50",
      username: "anvia",
      globalName: "Anvia",
      bot: true,
    },
    direct: false,
    thread: false,
    system: false,
    mentionedBot: true,
    ...overrides,
  };
}
