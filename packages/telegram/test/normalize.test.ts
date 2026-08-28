import { describe, expect, it } from "vitest";
import { normalizeTelegramUpdate } from "../src/index.js";
import type { TelegramChat, TelegramUpdate, TelegramUser } from "../src/index.js";

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

    expect(normalizeTelegramUpdate(update, bot)).toEqual([
      {
        type: "message",
        id: "10",
        platform: "telegram",
        accountId: "42",
        conversation: { id: "5", kind: "direct" },
        sender: { id: "7", displayName: "Indra Zulfi", bot: false },
        text: "hello",
        attachments: [],
        mentionedBot: false,
        raw: update,
      },
    ]);
  });

  it("normalizes the largest photo and accepts captionless media", () => {
    const update = messageUpdate({
      updateId: 14,
      chatId: 5,
      chatType: "private",
      photo: [
        { file_id: "small", width: 90, height: 90, file_size: 10 },
        { file_id: "large", width: 800, height: 800, file_size: 100 },
      ],
    });

    const event = normalizeTelegramUpdate(update, bot)[0];
    expect(event?.type === "message" ? event.attachments : undefined).toEqual([
      { id: "large", type: "image", mediaType: "image/jpeg", size: 100 },
    ]);
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

    expect(normalizeTelegramUpdate(update, bot)[0]).toMatchObject({
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

    const commandEvent = normalizeTelegramUpdate(command, bot)[0];
    const replyEvent = normalizeTelegramUpdate(reply, bot)[0];
    expect(commandEvent?.type === "message" && commandEvent.mentionedBot).toBe(true);
    expect(replyEvent?.type === "message" && replyEvent.mentionedBot).toBe(true);
    expect(replyEvent).toMatchObject({
      replyTo: { messageId: "99", sender: { id: "42", bot: true }, text: "previous" },
    });
  });

  it("normalizes edited messages and reactions", () => {
    const edited: TelegramUpdate = {
      update_id: 20,
      edited_message: {
        message_id: 10,
        from: { id: 7, is_bot: false, first_name: "Indra" },
        chat: { id: 5, type: "private" },
        text: "edited",
      },
    };
    const reaction: TelegramUpdate = {
      update_id: 21,
      message_reaction: {
        chat: { id: 5, type: "private" },
        message_id: 10,
        user: { id: 7, is_bot: false, first_name: "Indra" },
        date: 1_700_000_000,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    };

    expect(normalizeTelegramUpdate(edited, bot)[0]).toMatchObject({
      type: "message-edited",
      messageId: "10",
      text: "edited",
    });
    expect(normalizeTelegramUpdate(reaction, bot)[0]).toMatchObject({
      type: "reaction",
      messageId: "10",
      reaction: "👍",
      removed: false,
    });
  });

  it("emits every reaction delta and supports anonymous custom reactions", () => {
    const update: TelegramUpdate = {
      update_id: 22,
      message_reaction: {
        chat: { id: -100, type: "channel", title: "Anvia" },
        message_id: 10,
        actor_chat: { id: -200, type: "channel", title: "Release Bot" },
        date: 1_700_000_001,
        old_reaction: [{ type: "emoji", emoji: "👍" }],
        new_reaction: [{ type: "custom_emoji", custom_emoji_id: "custom-1" }],
      },
    };

    expect(normalizeTelegramUpdate(update, bot)).toMatchObject([
      {
        type: "reaction",
        id: "22:reaction:1",
        sender: { id: "-200", displayName: "Release Bot", bot: false },
        reaction: "👍",
        removed: true,
      },
      {
        type: "reaction",
        id: "22:reaction:2",
        sender: { id: "-200", displayName: "Release Bot", bot: false },
        reaction: "telegram:custom_emoji:custom-1",
        removed: false,
      },
    ]);
  });

  it("normalizes callback queries as action events", () => {
    const update: TelegramUpdate = {
      update_id: 15,
      callback_query: {
        id: "callback-1",
        from: { id: 7, is_bot: false, first_name: "Indra" },
        data: "anvia:token:approve",
        message: {
          message_id: 77,
          message_thread_id: 9,
          chat: { id: -100, type: "supergroup" },
          text: "Approve?",
        },
      },
    };

    expect(normalizeTelegramUpdate(update, bot)[0]).toMatchObject({
      type: "action",
      id: "15",
      actionId: "anvia:token:approve",
      messageId: "77",
      conversation: { id: "-100", kind: "group", threadId: "9" },
      sender: { id: "7", displayName: "Indra", bot: false },
    });
  });

  it("ignores updates without text or a user sender", () => {
    expect(normalizeTelegramUpdate({ update_id: 1 }, bot)).toEqual([]);
    expect(
      normalizeTelegramUpdate(
        {
          update_id: 2,
          message: { message_id: 1, chat: { id: -1, type: "channel" }, text: "post" },
        },
        bot,
      ),
    ).toEqual([]);
  });
});

type MessageUpdateOptions = Readonly<{
  updateId: number;
  chatId: number;
  chatType: "private" | "group" | "supergroup";
  text?: string;
  photo?: NonNullable<TelegramUpdate["message"]>["photo"];
  threadId?: number;
  entities?: NonNullable<TelegramUpdate["message"]>["entities"];
  replyToBot?: boolean;
}>;

function messageUpdate(options: MessageUpdateOptions): TelegramUpdate {
  const message: {
    message_id: number;
    message_thread_id?: number;
    from: TelegramUser;
    chat: TelegramChat;
    text?: string;
    photo?: NonNullable<NonNullable<TelegramUpdate["message"]>["photo"]>;
    entities?: NonNullable<NonNullable<TelegramUpdate["message"]>["entities"]>;
    reply_to_message?: NonNullable<NonNullable<TelegramUpdate["message"]>["reply_to_message"]>;
  } = {
    message_id: options.updateId,
    from: {
      id: 7,
      is_bot: false,
      first_name: "Indra",
      last_name: "Zulfi",
    },
    chat: { id: options.chatId, type: options.chatType },
  };
  if (options.threadId !== undefined) message.message_thread_id = options.threadId;
  if (options.text !== undefined) message.text = options.text;
  if (options.photo !== undefined) message.photo = options.photo;
  if (options.entities !== undefined) message.entities = options.entities;
  if (options.replyToBot) {
    message.reply_to_message = {
      message_id: 99,
      from: bot,
      chat: { id: options.chatId, type: options.chatType },
      text: "previous",
    };
  }
  return {
    update_id: options.updateId,
    message,
  };
}
