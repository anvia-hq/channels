import { describe, expect, it, vi } from "vitest";
import { DiscordJsGateway } from "../src/index.js";

describe("DiscordJsGateway REST delivery", () => {
  it("creates and edits messages with mentions disabled", async () => {
    const post = vi.fn().mockResolvedValue({ id: "77", channel_id: "20" });
    const patch = vi.fn().mockResolvedValue({ id: "77", channel_id: "20" });
    const gateway = new DiscordJsGateway({ token: "test-token" }, { post, patch });

    await expect(gateway.send("20", "hello @everyone")).resolves.toEqual({
      id: "77",
      channelId: "20",
    });
    expect(post).toHaveBeenCalledWith("/channels/20/messages", {
      body: {
        content: "hello @everyone",
        allowed_mentions: { parse: [] },
      },
    });

    await gateway.edit("20", "77", "updated");
    expect(patch).toHaveBeenCalledWith("/channels/20/messages/77", {
      body: {
        content: "updated",
        allowed_mentions: { parse: [] },
      },
    });
  });

  it("rejects invalid create-message responses and empty tokens", async () => {
    const post = vi.fn().mockResolvedValue({ unexpected: true });
    const patch = vi.fn();
    const gateway = new DiscordJsGateway({ token: "test-token" }, { post, patch });

    await expect(gateway.send("20", "hello")).rejects.toThrow("create-message response is invalid");
    expect(() => new DiscordJsGateway({ token: "" }, { post, patch })).toThrow(
      "token must not be empty",
    );
  });
});
