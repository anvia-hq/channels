import { describe, expect, it } from "vitest";
import { parseSlackSocketEvent, parseSlackSocketInteraction } from "../src/index.js";

const identity = { teamId: "T1", botUserId: "U2" };

describe("parseSlackSocketEvent", () => {
  it("parses direct messages", () => {
    expect(
      parseSlackSocketEvent(
        eventCallback({
          type: "message",
          channel: "D1",
          channel_type: "im",
          user: "U1",
          text: "hello",
          ts: "1700000000.000001",
        }),
        identity,
      ),
    ).toEqual({
      eventId: "Ev1",
      type: "message",
      teamId: "T1",
      channelId: "D1",
      channelType: "im",
      timestamp: "1700000000.000001",
      senderId: "U1",
      senderBot: false,
      text: "hello",
      files: [],
      botUserId: "U2",
    });
  });

  it("parses mentions with profile and thread context", () => {
    expect(
      parseSlackSocketEvent(
        eventCallback({
          type: "app_mention",
          channel: "C1",
          user: "U1",
          user_profile: { display_name: "Indra", real_name: "Indra Zulfi" },
          text: "hello <@U2>",
          ts: "1700000001.000002",
          thread_ts: "1700000000.000001",
        }),
        identity,
      ),
    ).toMatchObject({
      type: "app_mention",
      channelType: "channel",
      threadTimestamp: "1700000000.000001",
      senderDisplayName: "Indra",
      senderBot: false,
    });
  });

  it("runtime-validates attached Slack files", () => {
    expect(
      parseSlackSocketEvent(
        eventCallback({
          type: "message",
          subtype: "file_share",
          channel: "D1",
          channel_type: "im",
          user: "U1",
          text: "",
          ts: "1700000000.000001",
          files: [
            {
              id: "F1",
              name: "photo.png",
              mimetype: "image/png",
              size: 123,
              url_private_download: "https://files.slack.com/photo.png",
            },
          ],
        }),
        identity,
      )?.files,
    ).toEqual([
      {
        id: "F1",
        name: "photo.png",
        mediaType: "image/png",
        size: 123,
        privateDownloadUrl: "https://files.slack.com/photo.png",
      },
    ]);
  });

  it("allows human thread broadcasts and identifies bot senders", () => {
    const broadcast = eventCallback({
      type: "message",
      subtype: "thread_broadcast",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "follow-up",
      ts: "1700000001.000002",
      thread_ts: "1700000000.000001",
    });
    const botMention = eventCallback({
      type: "app_mention",
      channel: "C1",
      bot_id: "B1",
      text: "automation",
      ts: "1700000002.000003",
    });

    expect(parseSlackSocketEvent(broadcast, identity)?.threadTimestamp).toBe("1700000000.000001");
    expect(parseSlackSocketEvent(botMention, identity)?.senderBot).toBe(true);
  });

  it("ignores unsupported subtypes and malformed payloads", () => {
    expect(
      parseSlackSocketEvent(
        eventCallback({
          type: "message",
          subtype: "message_changed",
          channel: "C1",
          user: "U1",
          text: "edited",
          ts: "1700000000.000001",
        }),
        identity,
      ),
    ).toBeUndefined();
    expect(parseSlackSocketEvent({ type: "event_callback" }, identity)).toBeUndefined();
    expect(
      parseSlackSocketEvent(
        eventCallback({
          type: "message",
          channel: "D1",
          user: "U1",
          text: "file",
          ts: "1700000000.000001",
          files: [
            {
              id: "F1",
              url_private_download: "https://attacker.example/file",
            },
          ],
        }),
        identity,
      ),
    ).toBeUndefined();
  });

  it("runtime-validates interactive button callbacks", () => {
    expect(
      parseSlackSocketInteraction(
        {
          type: "block_actions",
          trigger_id: "trigger-1",
          team: { id: "T1" },
          channel: { id: "C1", type: "channel" },
          user: { id: "U1", name: "indra" },
          message: { ts: "1700000001.000002", thread_ts: "1700000000.000001" },
          actions: [
            {
              action_id: "button",
              value: "anvia:token:approve",
              action_ts: "1700000002.000003",
            },
          ],
        },
        identity,
      ),
    ).toEqual({
      type: "action",
      eventId: "trigger-1",
      teamId: "T1",
      channelId: "C1",
      channelType: "channel",
      messageTimestamp: "1700000001.000002",
      threadTimestamp: "1700000000.000001",
      senderId: "U1",
      senderDisplayName: "indra",
      actionId: "anvia:token:approve",
      actionTimestamp: "1700000002.000003",
      botUserId: "U2",
    });
  });
});

function eventCallback(
  event: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    type: "event_callback",
    event_id: "Ev1",
    team_id: "T1",
    event,
  };
}
