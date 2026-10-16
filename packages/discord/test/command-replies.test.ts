import { EventEmitter } from "node:events";
import { Client, Events } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordJsGateway } from "../src/index.js";
import type { DiscordGatewayHandler } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("Discord deferred command replies", () => {
  it("correlates overlapping commands and leaves proactive sends independent", async () => {
    const { gateway, client, post } = await startGateway(async (event) => {
      await gates.get(event.id)?.promise;
      await gateway.send(event.channelId, { text: `answer ${event.id}` });
    });
    const gates = new Map([
      ["101", gate()],
      ["102", gate()],
      ["103", gate()],
    ]);
    const first = command("101");
    const second = command("102");
    const other = command("103", "21");
    client.emit(Events.InteractionCreate, first);
    client.emit(Events.InteractionCreate, second);
    client.emit(Events.InteractionCreate, other);
    await vi.waitFor(() => expect(other.deferReply).toHaveBeenCalledOnce());

    await gateway.send("20", { text: "proactive" });
    expect(first.editReply).not.toHaveBeenCalled();
    expect(second.editReply).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledOnce();
    gates.get("102")?.resolve();
    await vi.waitFor(() =>
      expect(second.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: "answer 102", allowedMentions: { parse: [] } }),
      ),
    );
    gates.get("101")?.resolve();
    gates.get("103")?.resolve();
    await vi.waitFor(() =>
      expect(first.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: "answer 101" }),
      ),
    );
    await vi.waitFor(() => expect(other.editReply).toHaveBeenCalledOnce());
    await gateway.stop();
    expect(post).toHaveBeenCalledOnce();
  });

  it("preserves command context through a shared promise queue", async () => {
    const paused = gate();
    let tail = paused.promise;
    const { gateway, client, post } = await startGateway((event) => {
      tail = tail.then(async () => {
        await gateway.send(event.channelId, { text: event.id });
        await gateway.send(event.channelId, { text: `continuation ${event.id}` });
      });
      return tail;
    });
    const first = command("101");
    const second = command("102");
    client.emit(Events.InteractionCreate, first);
    client.emit(Events.InteractionCreate, second);
    await vi.waitFor(() => expect(second.deferReply).toHaveBeenCalledOnce());
    paused.resolve();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await gateway.stop();
    expect(first.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "101" }));
    expect(second.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "102" }));
  });

  it.each(["", "report"])("uploads files in a deferred reply with text %j", async (text) => {
    const { gateway, client, post } = await startGateway(async (event) => {
      await gateway.send(event.channelId, {
        text,
        attachments: [
          {
            type: "file",
            mediaType: "text/plain",
            filename: "report.txt",
            source: { type: "data", data: "aGk=" },
          },
        ],
      });
    });
    const interaction = command("101");
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledOnce());
    await gateway.stop();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: text,
        allowedMentions: { parse: [] },
        files: [{ attachment: Buffer.from("hi"), name: "report.txt" }],
      }),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it.each(["ignored", "failed"])(
    "cleans up %s commands without stealing the next send",
    async (mode) => {
      const { gateway, client, post, onError } = await startGateway(async () => {
        if (mode === "failed") throw new Error("handler failed");
      });
      const interaction = command("101");
      client.emit(Events.InteractionCreate, interaction);
      await vi.waitFor(() => expect(interaction.deleteReply).toHaveBeenCalledOnce());
      await gateway.send("20", { text: "normal send" });
      await gateway.stop();
      expect(interaction.editReply).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledTimes(mode === "failed" ? 1 : 0);
    },
  );

  it.each(["oversized", "download"])(
    "reports %s attachments without posting a fallback",
    async (mode) => {
      const { gateway, client, post, onError } = await startGateway(
        async (event) => {
          await gateway.send(event.channelId, {
            text: "report",
            attachments: [
              {
                type: "file",
                mediaType: "text/plain",
                ...(mode === "oversized" ? { size: 30 * 1024 * 1024 } : {}),
                source: { type: "url", url: "https://example.test/report.txt" },
              },
            ],
          });
        },
        { fetch: vi.fn().mockRejectedValue(new Error("download failed")) },
      );
      const interaction = command("101");
      client.emit(Events.InteractionCreate, interaction);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
      await gateway.stop();
      expect(interaction.editReply).not.toHaveBeenCalled();
      expect(interaction.deleteReply).toHaveBeenCalledOnce();
      expect(post).not.toHaveBeenCalled();
    },
  );

  it("rejects stale command sends during shutdown and after restart", async () => {
    const paused = gate();
    let detached!: Promise<unknown>;
    const { gateway, client, post } = await startGateway(async () => {
      detached = paused.promise
        .then(() => gateway.send("20", { text: "stale" }))
        .catch((error) => error);
    });
    const interaction = command("101");
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(interaction.deleteReply).toHaveBeenCalledOnce());
    await gateway.stop();
    await gateway.start(async () => undefined);
    paused.resolve();
    expect(await detached).toMatchObject({
      message: "Discord command handler is no longer active",
    });
    await gateway.send("20", { text: "fresh" });
    await gateway.stop();
    expect(post).toHaveBeenCalledOnce();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("rejects a follow-up file send if shutdown happens during download", async () => {
    const download = gate();
    const fetch = vi.fn(async () => {
      await download.promise;
      return new Response("file");
    });
    const { gateway, client, post, onError } = await startGateway(
      async () => {
        await gateway.send("20", { text: "first" });
        await gateway.send("20", {
          text: "follow-up",
          attachments: [
            {
              type: "file",
              mediaType: "text/plain",
              source: { type: "url", url: "https://example.test/file" },
            },
          ],
        });
      },
      { fetch },
    );
    const interaction = command("101");
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const stopping = gateway.stop();
    download.resolve();
    await stopping;
    expect(interaction.editReply).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Discord command handler is no longer active",
      }),
    );
  });

  it("rejects an in-flight command send once shutdown detaches its client", async () => {
    const paused = gate();
    const { gateway, client, post, onError } = await startGateway(async () => {
      await paused.promise;
      await gateway.send("20", { text: "stale" });
    });
    const interaction = command("101");
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(interaction.deferReply).toHaveBeenCalledOnce());
    const stopping = gateway.stop();
    paused.resolve();
    await stopping;
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Discord command handler is no longer active",
      }),
    );
    expect(post).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("propagates reply failures without falling back to a duplicate channel post", async () => {
    const { gateway, client, post, onError } = await startGateway(async (event) => {
      await gateway.send(event.channelId, { text: "answer" });
    });
    const interaction = command("101");
    interaction.editReply.mockRejectedValue(new Error("reply failed"));
    client.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await gateway.stop();
    expect(post).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"])(
    "waits for a concurrent initial reply %s before finishing cleanup and shutdown",
    async (outcome) => {
      const editing = gate();
      const handlerFinished = gate();
      const { gateway, client, post, onError } = await startGateway(async (event) => {
        try {
          await Promise.all([
            gateway.send(event.channelId, { text: "first" }),
            gateway.send(event.channelId, { text: "competing" }),
          ]);
        } finally {
          handlerFinished.resolve();
        }
      });
      const interaction = command("101");
      interaction.editReply.mockImplementation(async () => {
        await editing.promise;
        if (outcome === "failure") throw new Error("late edit failure");
        return { id: "77" };
      });
      client.emit(Events.InteractionCreate, interaction);
      await handlerFinished.promise;
      expect(interaction.editReply).toHaveBeenCalledOnce();
      expect(interaction.deleteReply).not.toHaveBeenCalled();

      let stopped = false;
      const stopping = gateway.stop().then(() => {
        stopped = true;
      });
      try {
        // Give an incorrectly untracked delivery time to finish before releasing the edit.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(stopped).toBe(false);
      } finally {
        editing.resolve();
        await stopping;
      }

      expect(interaction.deleteReply).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
      expect(post).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Discord command reply is already being sent" }),
      );
    },
  );
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function startGateway(
  handler: DiscordGatewayHandler,
  options: { fetch?: typeof globalThis.fetch } = {},
) {
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
  const post = vi.fn().mockResolvedValue({ id: "77", channel_id: "20" });
  const onError = vi.fn();
  const gateway = new DiscordJsGateway(
    { token: "test-token", onError, ...options },
    {
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
    },
  );
  await gateway.start(handler);
  const client = clients[0];
  if (client === undefined) throw new Error("Expected the mocked client to log in");
  return { gateway, client: client as unknown as EventEmitter, post, onError };
}

function command(id: string, channelId = "20") {
  return {
    id,
    channelId,
    guildId: "30",
    commandName: "ask",
    options: { data: [] },
    channel: { isThread: () => false, isDMBased: () => false },
    user: { id: "7", username: "User", globalName: null, bot: false },
    isChatInputCommand: () => true,
    isButton: () => false,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ id: "77" }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
  };
}
