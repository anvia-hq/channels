import { describe, expect, it, vi } from "vitest";
import { normalizeSlackMessage, slack } from "../src/index.js";
import { fakeTransport, slackMessage } from "./helpers.js";

describe("SlackChannel", () => {
  it("starts, normalizes messages, and stops gracefully", async () => {
    const fake = fakeTransport();
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const channel = slack({ transport: fake.transport });

    await channel.start(handler);
    await fake.emit(slackMessage());

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: "Ev1", text: "hello <@U2>", platform: "slack" }),
    );
    await channel.stop();
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it("does not dispatch bot-authored or unsupported messages", async () => {
    const fake = fakeTransport();
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const channel = slack({ transport: fake.transport });

    await channel.start(handler);
    await fake.emit(slackMessage({ senderId: "B1", senderBot: true }));
    await fake.emit(slackMessage({ text: "" }));

    expect(handler).not.toHaveBeenCalled();
    await channel.stop();
  });

  it("dispatches normalized interactive actions", async () => {
    const fake = fakeTransport();
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const channel = slack({ transport: fake.transport });
    await channel.start(handler);

    await fake.emit({
      type: "action",
      eventId: "trigger-1",
      teamId: "T1",
      channelId: "C1",
      channelType: "channel",
      messageTimestamp: "1700000001.000002",
      senderId: "U1",
      actionId: "anvia:token:approve",
      actionTimestamp: "1700000002.000003",
      botUserId: "U2",
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "action",
        messageId: "1700000001.000002",
        actionId: "anvia:token:approve",
      }),
    );
    await channel.stop();
  });

  it("does not dispatch malformed interactive actions", async () => {
    const fake = fakeTransport();
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const channel = slack({ transport: fake.transport });
    await channel.start(handler);

    await fake.emit({
      type: "action",
      eventId: "trigger-1",
      teamId: "T1",
      channelId: "C1",
      channelType: "channel",
      messageTimestamp: "1700000001.000002",
      senderId: "U1",
      actionId: "x".repeat(65),
      actionTimestamp: "1700000002.000003",
      botUserId: "U2",
    });

    expect(handler).not.toHaveBeenCalled();
    await channel.stop();
  });

  it("reports handler errors and continues receiving messages", async () => {
    const fake = fakeTransport();
    const failure = new Error("temporary failure");
    const handler = vi
      .fn<(event: unknown) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const channel = slack({ transport: fake.transport, onError });
    const first = slackMessage();

    await channel.start(handler);
    await fake.emit(first);
    await fake.emit(slackMessage({ eventId: "Ev2", timestamp: "1700000001.000002" }));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(failure, {
      operation: "handle",
      event: first,
    });
    await channel.stop();
  });

  it("sends and edits messages in threads", async () => {
    const fake = fakeTransport();
    const channel = slack({ transport: fake.transport });
    const sent = await channel.send(
      {
        platform: "slack",
        accountId: "T1",
        conversationId: "C1",
        threadId: "1700000000.000001",
      },
      { text: "alert" },
    );

    expect(fake.send).toHaveBeenCalledWith("C1", "1700000000.000001", { text: "alert" });
    expect(sent).toEqual({
      id: "1700000001.000002",
      address: {
        platform: "slack",
        accountId: "T1",
        conversationId: "C1",
        threadId: "1700000000.000001",
      },
    });

    await channel.edit(sent, { text: "resolved" });
    expect(fake.edit).toHaveBeenCalledWith("C1", "1700000001.000002", { text: "resolved" });
  });

  it("loads private attachments through the authenticated transport", async () => {
    const fake = fakeTransport();
    const channel = slack({ transport: fake.transport });
    const event = normalizeSlackMessage(
      slackMessage({
        files: [
          {
            id: "F1",
            name: "photo.png",
            mediaType: "image/png",
            size: 3,
            privateDownloadUrl: "https://files.slack.com/photo.png",
          },
        ],
      }),
    );
    if (event === undefined || event.attachments[0] === undefined) {
      throw new Error("Expected a normalized attachment");
    }

    await expect(channel.loadAttachment(event, event.attachments[0])).resolves.toEqual({
      type: "data",
      data: "ZmFrZQ==",
    });
    expect(fake.loadAttachment).toHaveBeenCalledWith(event.raw.files[0], undefined);
  });

  it("validates addresses, message limits, and lifecycle", async () => {
    const fake = fakeTransport();
    const channel = slack({ transport: fake.transport });

    await expect(
      channel.send({ platform: "discord", conversationId: "C1" }, { text: "hello" }),
    ).rejects.toThrow("cannot use a discord address");
    await expect(
      channel.send({ platform: "slack", conversationId: "invalid-id" }, { text: "hello" }),
    ).rejects.toThrow("must be a Slack ID");
    await expect(
      channel.send({ platform: "slack", conversationId: "C1" }, { text: "x".repeat(4_001) }),
    ).rejects.toThrow("must not exceed 4000");
    expect(
      channel.splitMessage({ text: "x".repeat(4_001) }).map((part) => part.text.length),
    ).toEqual([4_000, 1]);

    await channel.start(async () => undefined);
    await expect(channel.start(async () => undefined)).rejects.toThrow("already running");
    await channel.stop();
    await channel.stop();
  });

  it("can start again after a transport startup failure", async () => {
    const fake = fakeTransport();
    fake.start.mockRejectedValueOnce(new Error("login failed"));
    const channel = slack({ transport: fake.transport });

    await expect(channel.start(async () => undefined)).rejects.toThrow("login failed");
    await expect(channel.start(async () => undefined)).resolves.toBeUndefined();
    await channel.stop();
  });
});
