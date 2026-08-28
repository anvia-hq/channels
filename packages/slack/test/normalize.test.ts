import { describe, expect, it } from "vitest";
import { normalizeSlackMessage } from "../src/index.js";
import { slackMessage } from "./helpers.js";

describe("normalizeSlackMessage", () => {
  it("normalizes direct messages", () => {
    const message = slackMessage({
      type: "message",
      channelId: "D1",
      channelType: "im",
      text: "hello",
    });

    expect(normalizeSlackMessage(message)).toEqual({
      type: "message",
      id: "Ev1",
      platform: "slack",
      accountId: "T1",
      conversation: { id: "D1", kind: "direct" },
      sender: { id: "U1", displayName: "Indra", bot: false },
      text: "hello",
      attachments: [],
      mentionedBot: false,
      raw: message,
    });
  });

  it("normalizes image files and accepts file-only messages", () => {
    expect(
      normalizeSlackMessage(
        slackMessage({
          text: "",
          files: [
            {
              id: "F1",
              name: "image.png",
              mediaType: "image/png",
              size: 123,
              privateDownloadUrl: "https://files.slack.com/image.png",
            },
          ],
        }),
      )?.attachments,
    ).toEqual([
      {
        id: "F1",
        type: "image",
        mediaType: "image/png",
        filename: "image.png",
        size: 123,
      },
    ]);
  });

  it("normalizes channel mentions and multiparty threads", () => {
    expect(normalizeSlackMessage(slackMessage())?.mentionedBot).toBe(true);
    expect(
      normalizeSlackMessage(
        slackMessage({
          type: "message",
          channelId: "G1",
          channelType: "mpim",
          threadTimestamp: "1700000000.000000",
        }),
      ),
    ).toMatchObject({
      conversation: {
        id: "G1",
        kind: "group",
        threadId: "1700000000.000000",
      },
      mentionedBot: true,
    });
  });

  it("ignores empty and malformed messages", () => {
    expect(normalizeSlackMessage(slackMessage({ text: "" }))).toBeUndefined();
    expect(normalizeSlackMessage(slackMessage({ channelId: "invalid-id" }))).toBeUndefined();
  });
});
