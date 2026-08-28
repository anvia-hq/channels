import { describe, expect, it, vi } from "vitest";
import { DiscordJsGateway } from "../src/index.js";

describe("DiscordJsGateway REST delivery", () => {
  it("creates and edits messages with mentions disabled", async () => {
    const post = vi.fn().mockResolvedValue({ id: "77", channel_id: "20" });
    const patch = vi.fn().mockResolvedValue({ id: "77", channel_id: "20" });
    const gateway = new DiscordJsGateway({ token: "test-token" }, rest(post, patch));

    await expect(gateway.send("20", { text: "hello @everyone" })).resolves.toEqual({
      id: "77",
      channelId: "20",
    });
    expect(post).toHaveBeenCalledWith("/channels/20/messages", {
      body: {
        content: "hello @everyone",
        allowed_mentions: { parse: [] },
        components: [],
      },
    });

    await gateway.edit("20", "77", { text: "updated" });
    expect(patch).toHaveBeenCalledWith("/channels/20/messages/77", {
      body: {
        content: "updated",
        allowed_mentions: { parse: [] },
        components: [],
      },
    });
  });

  it("rejects invalid create-message responses and empty tokens", async () => {
    const post = vi.fn().mockResolvedValue({ unexpected: true });
    const patch = vi.fn();
    const gateway = new DiscordJsGateway({ token: "test-token" }, rest(post, patch));

    await expect(gateway.send("20", { text: "hello" })).rejects.toThrow(
      "create-message response is invalid",
    );
    expect(() => new DiscordJsGateway({ token: "" }, rest(post, patch))).toThrow(
      "token must not be empty",
    );
  });

  it("renders portable actions as Discord buttons", async () => {
    const post = vi.fn().mockResolvedValue({ id: "77", channel_id: "20" });
    const patch = vi.fn();
    const gateway = new DiscordJsGateway({ token: "test-token" }, rest(post, patch));

    await gateway.send("20", {
      text: "Approve?",
      actions: [
        { id: "anvia:token:approve", label: "Approve", style: "primary" },
        { id: "anvia:token:deny", label: "Deny", style: "danger" },
      ],
    });

    expect(post).toHaveBeenCalledWith("/channels/20/messages", {
      body: {
        content: "Approve?",
        allowed_mentions: { parse: [] },
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 1,
                label: "Approve",
                custom_id: "anvia:token:approve",
              },
              { type: 2, style: 4, label: "Deny", custom_id: "anvia:token:deny" },
            ],
          },
        ],
      },
    });
  });

  it("uploads base64 files and calls lifecycle REST routes", async () => {
    const post = vi.fn().mockResolvedValue({ id: "77", channel_id: "20" });
    const patch = vi.fn();
    const deleteRequest = vi.fn().mockResolvedValue(undefined);
    const put = vi.fn().mockResolvedValue(undefined);
    const gateway = new DiscordJsGateway(
      { token: "test-token" },
      rest(post, patch, deleteRequest, put),
    );

    await gateway.send("20", {
      text: "report",
      replyToMessageId: "76",
      attachments: [
        {
          type: "file",
          mediaType: "application/pdf",
          filename: "report.pdf",
          source: { type: "data", data: "cGRm" },
        },
      ],
    });
    expect(post).toHaveBeenCalledWith(
      "/channels/20/messages",
      expect.objectContaining({
        body: expect.objectContaining({ message_reference: { message_id: "76" } }),
        files: [{ data: Buffer.from("pdf"), name: "report.pdf" }],
      }),
    );

    await gateway.showTyping("20");
    await gateway.react("20", "77", "👍");
    await gateway.delete("20", "77");
    expect(post).toHaveBeenCalledWith("/channels/20/typing", {});
    expect(put).toHaveBeenCalledWith("/channels/20/messages/77/reactions/%F0%9F%91%8D/@me");
    expect(deleteRequest).toHaveBeenCalledWith("/channels/20/messages/77");
  });

  it("caps the total bytes buffered for one Discord message", async () => {
    const post = vi.fn().mockResolvedValue({ id: "77", channel_id: "20" });
    const gateway = new DiscordJsGateway(
      { token: "test-token", maximumAttachmentBytes: 3 },
      rest(post, vi.fn()),
    );

    await expect(
      gateway.send("20", {
        text: "files",
        attachments: [
          {
            type: "file",
            mediaType: "application/octet-stream",
            source: { type: "data", data: "AQI=" },
          },
          {
            type: "file",
            mediaType: "application/octet-stream",
            source: { type: "data", data: "AwQ=" },
          },
        ],
      }),
    ).rejects.toThrow("must not exceed 3 bytes in total");
    expect(post).not.toHaveBeenCalled();
  });
});

function rest(
  post: (...args: never[]) => Promise<unknown>,
  patch: (...args: never[]) => Promise<unknown>,
  deleteRequest = vi.fn(),
  put = vi.fn(),
) {
  return { post, patch, delete: deleteRequest, put };
}
