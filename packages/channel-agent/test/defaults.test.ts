import { describe, expect, it } from "vitest";
import {
  channelConversationKey,
  channelConversationSession,
  channelConversationUserSession,
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

  it("offers shared and sender-isolated conversation scopes", () => {
    const event = messageEvent();

    expect(channelConversationSession(event)).not.toHaveProperty("userId");
    expect(channelConversationUserSession(event)).toMatchObject({ userId: "telegram:user-1" });
    expect(defaultChannelAgentSession(event)).toEqual(channelConversationUserSession(event));
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

  it("distinguishes missing identifiers from identifier-like sentinel values", () => {
    const { accountId: _accountId, ...missingAccount } = messageEvent();
    const namedDefault = messageEvent({ accountId: "default" });
    const rootConversation = messageEvent({ conversation: { id: "conversation", kind: "direct" } });
    const rootThread = messageEvent({
      conversation: { id: "conversation", kind: "direct", threadId: "root" },
    });

    expect(channelConversationKey(missingAccount)).not.toBe(channelConversationKey(namedDefault));
    expect(channelConversationKey(rootConversation)).not.toBe(channelConversationKey(rootThread));
  });
});
