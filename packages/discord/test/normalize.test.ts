import { describe, expect, it } from "vitest";
import {
  normalizeDiscordAction,
  normalizeDiscordEvent,
  normalizeDiscordMessage,
} from "../src/index.js";
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
      attachments: [],
      mentionedBot: false,
      raw: message,
    });
  });

  it("normalizes image attachments and accepts media-only messages", () => {
    const message = discordMessage({
      content: "",
      attachments: [
        {
          id: "60",
          url: "https://cdn.discordapp.com/image.png",
          filename: "image.png",
          mediaType: "image/png",
          size: 123,
        },
      ],
    });

    expect(normalizeDiscordMessage(message)?.attachments).toEqual([
      {
        id: "60",
        type: "image",
        mediaType: "image/png",
        filename: "image.png",
        size: 123,
      },
    ]);
  });

  it("infers attachment type from a filename when Discord omits the media type", () => {
    const message = discordMessage({
      attachments: [
        {
          id: "60",
          url: "https://cdn.discordapp.com/image.png",
          filename: "image.png",
          size: 123,
        },
      ],
    });

    expect(normalizeDiscordMessage(message)?.attachments[0]).toMatchObject({
      type: "image",
      mediaType: "image/png",
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

  it("preserves reply references and normalizes lifecycle events", () => {
    expect(
      normalizeDiscordMessage(
        discordMessage({
          replyToMessageId: "70",
          replyToUser: { id: "41", username: "alex", bot: false },
        }),
      ),
    ).toMatchObject({ replyTo: { messageId: "70", sender: { id: "41" } } });
    expect(
      normalizeDiscordEvent({
        type: "message-deleted",
        id: "70:deleted",
        channelId: "20",
        messageId: "70",
        bot: { id: "50", username: "anvia", bot: true },
        direct: false,
        thread: false,
      }),
    ).toMatchObject({ type: "message-deleted", messageId: "70" });
    expect(
      normalizeDiscordEvent({
        type: "reaction",
        id: "reaction-1",
        channelId: "20",
        messageId: "70",
        reaction: "👍",
        removed: false,
        user: { id: "40", username: "indra", bot: false },
        bot: { id: "50", username: "anvia", bot: true },
        direct: false,
        thread: false,
      }),
    ).toMatchObject({ type: "reaction", reaction: "👍", removed: false });
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

  it("normalizes button interactions in threads", () => {
    expect(
      normalizeDiscordAction({
        type: "action",
        id: "90",
        channelId: "21",
        guildId: "30",
        parentChannelId: "20",
        messageId: "77",
        actionId: "anvia:token:approve",
        user: { id: "40", username: "indra", globalName: "Indra", bot: false },
        bot: { id: "50", username: "anvia", bot: true },
        direct: false,
        thread: true,
      }),
    ).toMatchObject({
      type: "action",
      id: "90",
      accountId: "50",
      conversation: { id: "20", kind: "channel", threadId: "21" },
      sender: { id: "40", displayName: "Indra", bot: false },
      messageId: "77",
      actionId: "anvia:token:approve",
    });
  });

  it("rejects malformed button interactions", () => {
    expect(
      normalizeDiscordAction({
        type: "action",
        id: "90",
        channelId: "20",
        messageId: "77",
        actionId: "x".repeat(65),
        user: { id: "40", username: "indra", bot: false },
        bot: { id: "not-a-snowflake", username: "anvia", bot: true },
        direct: false,
        thread: false,
      }),
    ).toBeUndefined();
  });
});
