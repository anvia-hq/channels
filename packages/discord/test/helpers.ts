import { vi } from "vitest";
import type {
  DiscordGateway,
  DiscordGatewayEvent,
  DiscordGatewayHandler,
  DiscordGatewayMessage,
} from "../src/index.js";

export type FakeDiscordGateway = Readonly<{
  gateway: DiscordGateway;
  start: ReturnType<typeof vi.fn<DiscordGateway["start"]>>;
  stop: ReturnType<typeof vi.fn<DiscordGateway["stop"]>>;
  send: ReturnType<typeof vi.fn<DiscordGateway["send"]>>;
  edit: ReturnType<typeof vi.fn<DiscordGateway["edit"]>>;
  delete: ReturnType<typeof vi.fn<DiscordGateway["delete"]>>;
  showTyping: ReturnType<typeof vi.fn<DiscordGateway["showTyping"]>>;
  react: ReturnType<typeof vi.fn<DiscordGateway["react"]>>;
  emit(event: DiscordGatewayEvent): Promise<void>;
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
  const deleteMessage = vi.fn<DiscordGateway["delete"]>(async () => undefined);
  const showTyping = vi.fn<DiscordGateway["showTyping"]>(async () => undefined);
  const react = vi.fn<DiscordGateway["react"]>(async () => undefined);

  return {
    gateway: { start, stop, send, edit, delete: deleteMessage, showTyping, react },
    start,
    stop,
    send,
    edit,
    delete: deleteMessage,
    showTyping,
    react,
    async emit(message) {
      if (handler === undefined) throw new Error("Fake Discord gateway is not running");
      await handler(message);
    },
  };
}

export function discordMessage(
  overrides: Partial<DiscordGatewayMessage> = {},
): DiscordGatewayMessage {
  const message: { -readonly [Key in keyof DiscordGatewayMessage]: DiscordGatewayMessage[Key] } = {
    id: "10",
    channelId: "20",
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
    type: "message",
  };
  if (overrides.direct !== true) message.guildId = "30";
  Object.assign(message, overrides);
  message.type = "message";
  return message;
}
