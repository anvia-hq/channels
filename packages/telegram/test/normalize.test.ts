import { describe, expect, it } from "vitest";
import { normalizeTelegramUpdate } from "../src/index.js";
import type { TelegramUpdate, TelegramUser } from "../src/index.js";

const bot: TelegramUser = {
  id: 42,
  is_bot: true,
  first_name: "Anvia",
  username: "anvia_bot",
};

describe("normalizeTelegramUpdate", () => {
  it("normalizes private text messages", () => {
    const update = messageUpdate({
      updateId: 10,
      chatId: 5,
      chatType: "private",
      text: "hello",
    });

    expect(normalizeTelegramUpdate(update, bot)).toEqual({
      type: "message",
      id: "10",
      platform: "telegram",
      accountId: "42",
      conversation: { id: "5", kind: "direct" },
      sender: { id: "7", displayName: "Indra Zulfi", bot: false },
      text: "hello",
      mentionedBot: false,
      raw: update,
    });
  });

  it("preserves topics and detects username mentions", () => {
    const text = "hello @anvia_bot";
    const update = messageUpdate({
      updateId: 11,
      chatId: -100,
      chatType: "supergroup",
      threadId: 9,
      text,
      entities: [{ type: "mention", offset: 6, length: 10 }],
    });

    expect(normalizeTelegramUpdate(update, bot)).toMatchObject({
      conversation: { id: "-100", kind: "group", threadId: "9" },
      mentionedBot: true,
    });
  });

  it("detects commands addressed to the bot and replies to the bot", () => {
    const command = messageUpdate({
      updateId: 12,
      chatId: -100,
      chatType: "group",
      text: "/ask@anvia_bot",
      entities: [{ type: "bot_command", offset: 0, length: 14 }],
    });
    const reply = messageUpdate({
      updateId: 13,
      chatId: -100,
      chatType: "group",
      text: "continue",
      replyToBot: true,
    });

    expect(normalizeTelegramUpdate(command, bot)?.mentionedBot).toBe(true);
    expect(normalizeTelegramUpdate(reply, bot)?.mentionedBot).toBe(true);
  });

  it("ignores updates without text or a user sender", () => {
    expect(normalizeTelegramUpdate({ update_id: 1 }, bot)).toBeUndefined();
    expect(
      normalizeTelegramUpdate(
        {
          update_id: 2,
          message: { message_id: 1, chat: { id: -1, type: "channel" }, text: "post" },
        },
        bot,
      ),
    ).toBeUndefined();
  });
});

type MessageUpdateOptions = Readonly<{
  updateId: number;
  chatId: number;
  chatType: "private" | "group" | "supergroup";
  text: string;
  threadId?: number;
  entities?: NonNullable<TelegramUpdate["message"]>["entities"];
  replyToBot?: boolean;
}>;

function messageUpdate(options: MessageUpdateOptions): TelegramUpdate {
  return {
    update_id: options.updateId,
    message: {
      message_id: options.updateId,
      ...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
      from: {
        id: 7,
        is_bot: false,
        first_name: "Indra",
        last_name: "Zulfi",
      },
      chat: { id: options.chatId, type: options.chatType },
      text: options.text,
      ...(options.entities === undefined ? {} : { entities: options.entities }),
      ...(options.replyToBot
        ? {
            reply_to_message: {
              message_id: 99,
              from: bot,
              chat: { id: options.chatId, type: options.chatType },
              text: "previous",
            },
          }
        : {}),
    },
  };
}
