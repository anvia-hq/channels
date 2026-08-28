import { describe, expect, it, vi } from "vitest";
import { discord, normalizeDiscordMessage } from "../src/index.js";
import { discordMessage, fakeGateway } from "./helpers.js";

describe("DiscordChannel", () => {
  it("starts the gateway, normalizes messages, and stops gracefully", async () => {
    const fake = fakeGateway();
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const channel = discord({ gateway: fake.gateway });

    await channel.start(handler);
    await fake.emit(discordMessage());

    expect(fake.start).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: "10", text: "hello", platform: "discord" }),
    );

    await channel.stop();
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it("does not dispatch bot-authored or unsupported messages", async () => {
    const fake = fakeGateway();
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const channel = discord({ gateway: fake.gateway });

    await channel.start(handler);
    await fake.emit(
      discordMessage({
        author: { id: "60", username: "other-bot", bot: true },
      }),
    );
    await fake.emit(discordMessage({ system: true }));

    expect(handler).not.toHaveBeenCalled();
    await channel.stop();
  });

  it("dispatches normalized button actions", async () => {
    const fake = fakeGateway();
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const channel = discord({ gateway: fake.gateway });
    await channel.start(handler);

    await fake.emit({
      type: "action",
      id: "90",
      channelId: "20",
      guildId: "30",
      messageId: "77",
      actionId: "anvia:token:approve",
      user: { id: "40", username: "indra", bot: false },
      bot: { id: "50", username: "anvia", bot: true },
      direct: false,
      thread: false,
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "action",
        messageId: "77",
        actionId: "anvia:token:approve",
      }),
    );
    await channel.stop();
  });

  it("reports handler errors and continues receiving messages", async () => {
    const fake = fakeGateway();
    const handlerError = new Error("temporary failure");
    const handler = vi
      .fn<(event: unknown) => Promise<void>>()
      .mockRejectedValueOnce(handlerError)
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const channel = discord({ gateway: fake.gateway, onError });

    await channel.start(handler);
    const first = discordMessage();
    await fake.emit(first);
    await fake.emit(discordMessage({ id: "11" }));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(handlerError, {
      operation: "handle",
      event: first,
    });
    await channel.stop();
  });

  it("sends and edits messages in channels and threads", async () => {
    const fake = fakeGateway();
    const channel = discord({ gateway: fake.gateway });
    const sent = await channel.send(
      {
        platform: "discord",
        accountId: "50",
        conversationId: "20",
        threadId: "21",
      },
      { text: "alert" },
    );

    expect(fake.send).toHaveBeenCalledWith("21", { text: "alert" });
    expect(sent).toEqual({
      id: "77",
      address: {
        platform: "discord",
        accountId: "50",
        conversationId: "20",
        threadId: "21",
      },
    });

    await channel.edit(sent, { text: "resolved" });
    expect(fake.edit).toHaveBeenCalledWith("21", "77", { text: "resolved" });
  });

  it("resolves normalized attachments to Discord CDN URLs", async () => {
    const channel = discord({ gateway: fakeGateway().gateway });
    const event = normalizeDiscordMessage(
      discordMessage({
        attachments: [
          {
            id: "60",
            url: "https://cdn.discordapp.com/photo.png",
            filename: "photo.png",
            mediaType: "image/png",
            size: 3,
          },
        ],
      }),
    );
    if (event === undefined || event.attachments[0] === undefined) {
      throw new Error("Expected a normalized attachment");
    }

    await expect(channel.loadAttachment(event, event.attachments[0])).resolves.toEqual({
      type: "url",
      url: "https://cdn.discordapp.com/photo.png",
    });
  });

  it("validates addresses, message limits, and lifecycle", async () => {
    const fake = fakeGateway();
    const channel = discord({ gateway: fake.gateway });

    await expect(
      channel.send({ platform: "telegram", conversationId: "20" }, { text: "hello" }),
    ).rejects.toThrow("cannot use a telegram address");
    await expect(
      channel.send({ platform: "discord", conversationId: "invalid" }, { text: "hello" }),
    ).rejects.toThrow("must be a snowflake");
    await expect(
      channel.send({ platform: "discord", conversationId: "20" }, { text: "x".repeat(2_001) }),
    ).rejects.toThrow("must not exceed 2000");
    expect(
      channel.splitMessage({ text: "x".repeat(2_001) }).map((part) => part.text.length),
    ).toEqual([2_000, 1]);

    await channel.start(async () => undefined);
    await expect(channel.start(async () => undefined)).rejects.toThrow("already running");
    await channel.stop();
    await channel.stop();
  });

  it("can start again after a gateway startup failure", async () => {
    const fake = fakeGateway();
    fake.start.mockRejectedValueOnce(new Error("login failed"));
    const channel = discord({ gateway: fake.gateway });

    await expect(channel.start(async () => undefined)).rejects.toThrow("login failed");
    await expect(channel.start(async () => undefined)).resolves.toBeUndefined();
    await channel.stop();
  });
});
