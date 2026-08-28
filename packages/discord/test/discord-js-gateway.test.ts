import { describe, expect, it, vi } from "vitest";
import { DiscordJsGateway } from "../src/index.js";

describe("DiscordJsGateway REST delivery", () => {
  it("creates and edits messages with mentions disabled", async () => {
    const post = vi.fn().mockResolvedValue({ id: "77", channel_id: "20" });
    const patch = vi.fn().mockResolvedValue({ id: "77", channel_id: "20" });
    const gateway = new DiscordJsGateway({ token: "test-token" }, { post, patch });

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
    const gateway = new DiscordJsGateway({ token: "test-token" }, { post, patch });

    await expect(gateway.send("20", { text: "hello" })).rejects.toThrow(
      "create-message response is invalid",
    );
    expect(() => new DiscordJsGateway({ token: "" }, { post, patch })).toThrow(
      "token must not be empty",
    );
  });

  it("renders portable actions as Discord buttons", async () => {
    const post = vi.fn().mockResolvedValue({ id: "77", channel_id: "20" });
    const patch = vi.fn();
    const gateway = new DiscordJsGateway({ token: "test-token" }, { post, patch });

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
});
