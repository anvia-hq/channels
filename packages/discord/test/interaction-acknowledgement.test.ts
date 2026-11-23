import type { EventEmitter } from "node:events";
import { Client, Events } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordJsGateway } from "../src/index.js";
import type { DiscordGatewayHandler } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("Discord interaction acknowledgement", () => {
  it("dispatches a button click after acknowledging it", async () => {
    const { client, handler } = await startGateway();
    const interaction = button();

    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "action",
        id: "900",
        channelId: "20",
        messageId: "77",
        actionId: "anvia:token:approve",
      }),
    );
  });

  it("replies to interaction types the adapter does not handle", async () => {
    const { client, handler, onError } = await startGateway();
    const interaction = selectMenu();

    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(handler).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "This bot cannot handle this interaction.",
      flags: 64,
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Discord interaction type 3 is not supported" }),
    );
  });

  it("resolves autocomplete interactions and reports them", async () => {
    const { client, onError } = await startGateway();
    const interaction = autocomplete();

    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(interaction.respond).toHaveBeenCalledOnce());

    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Discord autocomplete interactions are not supported" }),
    );
  });

  it("replies when a button payload cannot be read", async () => {
    const { client, handler, onError } = await startGateway();
    const interaction = button();

    Object.assign(interaction, { channel: null });
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(handler).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Discord button interaction could not be read" }),
    );
  });

  it("reports a failed acknowledgement instead of running the handler", async () => {
    const { client, handler, onError } = await startGateway();
    const interaction = command();

    interaction.deferReply.mockRejectedValue(new Error("Unknown interaction"));
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(handler).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Unknown interaction" }),
    );
  });
});

async function startGateway() {
  const clients: Client[] = [];
  vi.spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
    clients.push(this);
    Object.defineProperty(this, "user", {
      value: { id: "42", username: "Bot", globalName: null, bot: true },
      configurable: true,
    });
    return "test-token";
  });
  vi.spyOn(Client.prototype, "destroy").mockResolvedValue(undefined);
  const handler = vi.fn<DiscordGatewayHandler>(async () => {});
  const onError = vi.fn();
  const gateway = new DiscordJsGateway(
    { token: "test-token", onError },
    {
      post: vi.fn().mockResolvedValue({ id: "77", channel_id: "20" }),
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
    },
  );
  await gateway.start(handler);
  const client = clients[0];

  if (client === undefined) throw new Error("Expected the mocked client to log in");

  return { client: client as unknown as EventEmitter, handler, onError };
}

const user = { id: "7", username: "User", globalName: null, bot: false };
const channel = { isThread: () => false, isDMBased: () => false, parentId: null };

function button(customId = "anvia:token:approve") {
  return {
    id: "900",
    type: 3,
    channelId: "20",
    guildId: "30",
    customId,
    message: { id: "77" },
    channel: { ...channel },
    user: { ...user },
    isChatInputCommand: () => false,
    isButton: () => true,
    isAutocomplete: () => false,
    isRepliable: () => true,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function command() {
  return {
    id: "101",
    type: 2,
    channelId: "20",
    guildId: "30",
    commandName: "ask",
    options: { data: [] },
    channel: { ...channel },
    user: { ...user },
    isChatInputCommand: () => true,
    isButton: () => false,
    isAutocomplete: () => false,
    isRepliable: () => true,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ id: "77" }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function selectMenu() {
  return {
    id: "901",
    type: 3,
    channelId: "20",
    guildId: "30",
    channel: { ...channel },
    user: { ...user },
    isChatInputCommand: () => false,
    isButton: () => false,
    isAutocomplete: () => false,
    isRepliable: () => true,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function autocomplete() {
  return {
    id: "902",
    type: 4,
    channelId: "20",
    guildId: "30",
    channel: { ...channel },
    user: { ...user },
    isChatInputCommand: () => false,
    isButton: () => false,
    isAutocomplete: () => true,
    isRepliable: () => true,
    respond: vi.fn().mockResolvedValue(undefined),
  };
}
