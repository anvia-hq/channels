import { describe, expect, it } from "vitest";
import {
  channelConversationKey,
  defaultChannelAgentSession,
  defaultShouldHandleChannelEvent,
} from "../src/index.js";
import { messageEvent } from "./helpers.js";

describe("channel agent defaults", () => {
  it("handles direct messages and mentioned group messages", () => {
    expect(defaultShouldHandleChannelEvent(messageEvent())).toBe(true);
    expect(
      defaultShouldHandleChannelEvent(
        messageEvent({ conversation: { id: "group", kind: "group" } }),
      ),
    ).toBe(false);
    expect(
      defaultShouldHandleChannelEvent(
        messageEvent({
          conversation: { id: "group", kind: "group" },
          mentionedBot: true,
        }),
      ),
    ).toBe(true);
    expect(
      defaultShouldHandleChannelEvent(
        messageEvent({ sender: { id: "bot", displayName: "Bot", bot: true } }),
      ),
    ).toBe(false);
  });

  it("creates stable, platform-qualified memory scopes", () => {
    const event = messageEvent({
      platform: "telegram",
      accountId: "42",
      conversation: { id: "-100", kind: "group", threadId: "9" },
      sender: { id: "7", displayName: "Indra", bot: false },
    });

    expect(channelConversationKey(event)).toBe("channel:telegram:42:-100:9");
    expect(defaultChannelAgentSession(event)).toEqual({
      sessionId: "channel:telegram:42:-100:9",
      userId: "telegram:7",
      metadata: {
        platform: "telegram",
        accountId: "42",
        conversationId: "-100",
        conversationKind: "group",
        threadId: "9",
      },
    });
  });

  it("escapes identifiers so separators cannot collide", () => {
    const first = messageEvent({
      platform: "custom:platform",
      conversation: { id: "conversation", kind: "direct" },
    });
    const second = messageEvent({
      platform: "custom",
      accountId: "platform:default",
      conversation: { id: "conversation", kind: "direct" },
    });

    expect(channelConversationKey(first)).not.toBe(channelConversationKey(second));
    expect(channelConversationKey(first)).toContain("custom%3Aplatform");
  });
});
