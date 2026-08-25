import { describe, expect, it } from "vitest";
import { normalizeDiscordMessage } from "../src/index.js";
import { discordMessage } from "./helpers.js";

describe("normalizeDiscordMessage", () => {
  it("normalizes direct messages", () => {
    const message = discordMessage({
      direct: true,
      mentionedBot: false,
    });

    expect(normalizeDiscordMessage(message)).toEqual({
      type: "message",
      id: "10",
      platform: "discord",
      accountId: "50",
      conversation: { id: "20", kind: "direct" },
      sender: { id: "40", displayName: "Indra", bot: false },
      text: "hello",
      mentionedBot: false,
      raw: message,
    });
  });

  it("uses guild display names and detects bot mentions", () => {
    expect(
      normalizeDiscordMessage(discordMessage({ memberDisplayName: "Indra Z", mentionedBot: true })),
    ).toMatchObject({
      conversation: { id: "20", kind: "channel" },
      sender: { displayName: "Indra Z" },
      mentionedBot: true,
    });
  });

  it("preserves the parent channel and thread address", () => {
    expect(
      normalizeDiscordMessage(
        discordMessage({ channelId: "21", parentChannelId: "20", thread: true }),
      ),
    ).toMatchObject({
      conversation: { id: "20", kind: "channel", threadId: "21" },
    });
  });

  it("ignores system, empty, and malformed messages", () => {
    expect(normalizeDiscordMessage(discordMessage({ system: true }))).toBeUndefined();
    expect(normalizeDiscordMessage(discordMessage({ content: "" }))).toBeUndefined();
    expect(
      normalizeDiscordMessage(discordMessage({ channelId: "not-a-snowflake" })),
    ).toBeUndefined();
  });
});
