import { describe, expect, it, vi } from "vitest";
import { normalizeTelegramUpdate, TelegramApiError, telegram } from "../src/index.js";
import type {
  TelegramBotApi,
  TelegramMessage,
  TelegramUpdate,
  TelegramUpdateBatch,
  TelegramUser,
} from "../src/index.js";

const bot: TelegramUser = {
  id: 42,
  is_bot: true,
  first_name: "Anvia",
  username: "anvia_bot",
};

describe("TelegramChannel", () => {
  it("polls, normalizes, advances the offset, and stops gracefully", async () => {
    const update = textUpdate(10);
    const fake = fakeApi();
    fake.getUpdates
      .mockResolvedValueOnce({ updates: [update], invalid: [] })
      .mockImplementation(waitForAbort);
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const channel = telegram({ api: fake.api, polling: { retryDelayMs: 0 } });

    await channel.start(handler);
    await vi.waitFor(() => expect(fake.getUpdates).toHaveBeenCalledTimes(2));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: "10", text: "hello", platform: "telegram" }),
    );
    expect(fake.getUpdates.mock.calls[0]?.[0]).toEqual({
      limit: 100,
      timeout: 30,
      allowed_updates: ["message", "edited_message", "message_reaction", "callback_query"],
    });
    expect(fake.getUpdates.mock.calls[1]?.[0]).toMatchObject({ offset: 11 });

    await channel.stop();
  });

  it("does not dispatch bot-authored messages", async () => {
    const fake = fakeApi();
    fake.getUpdates
      .mockResolvedValueOnce({
        updates: [textUpdate(1, { sender: bot }), textUpdate(2)],
        invalid: [],
      })
      .mockImplementation(waitForAbort);
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const channel = telegram({ api: fake.api });

    await channel.start(handler);
    await vi.waitFor(() => expect(fake.getUpdates).toHaveBeenCalledTimes(2));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ id: "2" });

    await channel.stop();
  });

  it("retries an update when the handler fails", async () => {
    const update = textUpdate(10);
    const fake = fakeApi();
    fake.getUpdates
      .mockResolvedValueOnce({ updates: [update], invalid: [] })
      .mockResolvedValueOnce({ updates: [update], invalid: [] })
      .mockImplementation(waitForAbort);
    const handler = vi
      .fn<(event: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const channel = telegram({
      api: fake.api,
      polling: { retryDelayMs: 0 },
      onError,
    });

    await channel.start(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fake.getUpdates).toHaveBeenCalledTimes(3));

    expect(fake.getUpdates.mock.calls[1]?.[0].offset).toBeUndefined();
    expect(fake.getUpdates.mock.calls[2]?.[0].offset).toBe(11);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "temporary failure" }),
      { operation: "handle", update },
    );

    await channel.stop();
  });

  it("reports a polling error and continues receiving updates", async () => {
    const pollError = new Error("temporary network error");
    const fake = fakeApi();
    fake.getUpdates
      .mockRejectedValueOnce(pollError)
      .mockResolvedValueOnce({ updates: [textUpdate(10)], invalid: [] })
      .mockImplementation(waitForAbort);
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const onError = vi.fn();
    const channel = telegram({
      api: fake.api,
      polling: { retryDelayMs: 0 },
      onError,
    });

    await channel.start(handler);
    await vi.waitFor(() => expect(fake.getUpdates).toHaveBeenCalledTimes(3));

    expect(onError).toHaveBeenCalledWith(pollError, { operation: "poll" });
    expect(handler).toHaveBeenCalledOnce();
    expect(fake.getUpdates.mock.calls[2]?.[0].offset).toBe(11);

    await channel.stop();
  });

  it("backs off exponentially between poll failures and resets after success", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeApi();
      fake.getUpdates
        .mockRejectedValueOnce(new Error("first failure"))
        .mockRejectedValueOnce(new Error("second failure"))
        .mockResolvedValueOnce({ updates: [textUpdate(10)], invalid: [] })
        .mockRejectedValueOnce(new Error("third failure"))
        .mockRejectedValueOnce(new Error("fourth failure"))
        .mockImplementation(waitForAbort);
      const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
      const channel = telegram({
        api: fake.api,
        polling: { retryDelayMs: 10 },
      });

      await channel.start(handler);
      expect(fake.getUpdates).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(fake.getUpdates).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(10);
      expect(fake.getUpdates).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(10);
      expect(fake.getUpdates).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(10);
      expect(fake.getUpdates).toHaveBeenCalledTimes(5);

      await vi.advanceTimersByTimeAsync(10);
      expect(fake.getUpdates).toHaveBeenCalledTimes(5);

      await vi.advanceTimersByTimeAsync(10);
      expect(fake.getUpdates).toHaveBeenCalledTimes(6);

      await channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors Telegram retry_after over the backoff curve", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeApi();
      fake.getUpdates
        .mockRejectedValueOnce(
          new TelegramApiError("getUpdates", "Too Many Requests", {
            errorCode: 429,
            retryAfterSeconds: 3,
          }),
        )
        .mockImplementation(waitForAbort);
      const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
      const channel = telegram({
        api: fake.api,
        polling: { retryDelayMs: 10 },
      });

      await channel.start(handler);
      expect(fake.getUpdates).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_999);
      expect(fake.getUpdates).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(fake.getUpdates).toHaveBeenCalledTimes(2);

      await channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips and reports malformed updates without stalling the batch", async () => {
    const fake = fakeApi();
    fake.getUpdates
      .mockResolvedValueOnce({
        updates: [textUpdate(7)],
        invalid: [
          { updateId: 8, error: new TypeError("malformed payload") },
          { updateId: undefined, error: new TypeError("unidentifiable payload") },
        ],
      })
      .mockImplementation(waitForAbort);
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const onError = vi.fn();
    const channel = telegram({
      api: fake.api,
      polling: { retryDelayMs: 0 },
      onError,
    });

    await channel.start(handler);
    await vi.waitFor(() => expect(fake.getUpdates).toHaveBeenCalledTimes(2));

    expect(handler).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(TypeError), { operation: "poll" });
    expect(fake.getUpdates.mock.calls[1]?.[0].offset).toBe(9);

    await channel.stop();
  });

  it("sends to chats and topics and edits sent messages", async () => {
    const fake = fakeApi();
    const channel = telegram({ api: fake.api });
    const sent = await channel.send(
      {
        platform: "telegram",
        accountId: "42",
        conversationId: "-100",
        threadId: "9",
      },
      { text: "alert" },
    );

    expect(fake.sendMessage).toHaveBeenCalledWith({
      chat_id: -100,
      message_thread_id: 9,
      text: "alert",
    });
    expect(sent).toEqual({
      id: "77",
      address: {
        platform: "telegram",
        accountId: "42",
        conversationId: "-100",
        threadId: "9",
      },
    });

    await channel.edit(sent, { text: "resolved" });
    expect(fake.editMessageText).toHaveBeenCalledWith({
      chat_id: -100,
      message_id: 77,
      text: "resolved",
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("renders inline actions and acknowledges callbacks before dispatch", async () => {
    const fake = fakeApi();
    const update: TelegramUpdate = {
      update_id: 20,
      callback_query: {
        id: "callback-1",
        from: { id: 7, is_bot: false, first_name: "Indra" },
        data: "anvia:token:approve",
        message: {
          message_id: 77,
          chat: { id: -100, type: "supergroup" },
          text: "Approve?",
        },
      },
    };
    fake.getUpdates
      .mockResolvedValueOnce({ updates: [update], invalid: [] })
      .mockImplementation(waitForAbort);
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const channel = telegram({ api: fake.api });

    await channel.send(
      { platform: "telegram", conversationId: "-100" },
      {
        text: "Approve?",
        actions: [
          { id: "anvia:token:approve", label: "Approve", style: "primary" },
          { id: "anvia:token:deny", label: "Deny", style: "danger" },
        ],
      },
    );
    expect(fake.sendMessage).toHaveBeenCalledWith({
      chat_id: -100,
      text: "Approve?",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: "anvia:token:approve" },
            { text: "Deny", callback_data: "anvia:token:deny" },
          ],
        ],
      },
    });

    await channel.start(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(fake.answerCallbackQuery).toHaveBeenCalledWith(
      { callback_query_id: "callback-1" },
      expect.any(AbortSignal),
    );
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "action", actionId: "anvia:token:approve" }),
    );
    await channel.stop();
  });

  it("authenticates and dispatches webhook updates", async () => {
    const fake = fakeApi();
    const handler = vi.fn(async () => undefined);
    const channel = telegram({ api: fake.api, webhook: { secretToken: "webhook_secret" } });
    await channel.start(handler);

    await expect(channel.receiveWebhook(textUpdate(25), "wrong")).rejects.toThrow(
      "secret token is invalid",
    );
    await channel.receiveWebhook(textUpdate(25), "webhook_secret");
    await channel.receiveWebhook(textUpdate(25), "webhook_secret");

    expect(fake.getUpdates).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: "25", text: "hello" }));
    await channel.stop();
  });

  it("coalesces concurrent deliveries of the same webhook update", async () => {
    const fake = fakeApi();
    let releaseHandler: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const handler = vi.fn(async () => {
      markStarted?.();
      await handlerGate;
    });
    const channel = telegram({ api: fake.api, webhook: { secretToken: "webhook_secret" } });
    await channel.start(handler);

    const first = channel.receiveWebhook(textUpdate(26), "webhook_secret");
    await started;
    const duplicate = channel.receiveWebhook(textUpdate(26), "webhook_secret");
    releaseHandler?.();
    await Promise.all([first, duplicate]);

    expect(handler).toHaveBeenCalledOnce();
    await channel.stop();
  });

  it("dispatches every reaction change from one update", async () => {
    const update: TelegramUpdate = {
      update_id: 27,
      message_reaction: {
        chat: { id: -100, type: "supergroup" },
        message_id: 7,
        user: { id: 5, is_bot: false, first_name: "Indra" },
        date: 1_700_000_000,
        old_reaction: [{ type: "emoji", emoji: "👍" }],
        new_reaction: [{ type: "emoji", emoji: "❤️" }],
      },
    };
    const fake = fakeApi();
    fake.getUpdates
      .mockResolvedValueOnce({ updates: [update], invalid: [] })
      .mockImplementation(waitForAbort);
    const handler = vi.fn<(event: unknown) => Promise<void>>(async () => undefined);
    const channel = telegram({ api: fake.api });

    await channel.start(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));

    expect(handler.mock.calls.map(([event]) => event)).toMatchObject([
      { reaction: "👍", removed: true },
      { reaction: "❤️", removed: false },
    ]);
    await channel.stop();
  });

  it("sends attachments, replies, typing, reactions, and deletion", async () => {
    const fake = fakeApi();
    const channel = telegram({ api: fake.api });
    const sent = await channel.send(
      { platform: "telegram", conversationId: "-100" },
      {
        text: "report",
        replyToMessageId: "12",
        attachments: [
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "report.pdf",
            source: { type: "data", data: "cGRm" },
          },
        ],
      },
    );

    expect(fake.sendMessage).toHaveBeenCalledWith({
      chat_id: -100,
      text: "report",
      reply_parameters: { message_id: 12 },
    });
    expect(fake.sendAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: -100,
        attachment: expect.objectContaining({ type: "file" }),
      }),
    );
    await channel.showTyping({ platform: "telegram", conversationId: "-100" });
    await channel.react(sent, "👍");
    await channel.delete(sent);
    expect(fake.sendChatAction).toHaveBeenCalledWith({ chat_id: -100, action: "typing" });
    expect(fake.setMessageReaction).toHaveBeenCalledWith({
      chat_id: -100,
      message_id: 77,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    expect(fake.deleteMessage).toHaveBeenCalledWith({ chat_id: -100, message_id: 77 });
  });

  it("loads Telegram media through the authenticated Bot API", async () => {
    const fake = fakeApi();
    const channel = telegram({ api: fake.api });
    const update: TelegramUpdate = {
      update_id: 88,
      message: {
        message_id: 88,
        from: { id: 7, is_bot: false, first_name: "Indra" },
        chat: { id: 7, type: "private" },
        photo: [{ file_id: "photo-id", width: 100, height: 100, file_size: 3 }],
      },
    };
    const event = normalizeTelegramUpdate(update, bot)[0];
    if (event?.type !== "message" || event.attachments[0] === undefined) {
      throw new Error("Expected a normalized attachment");
    }

    await expect(channel.loadAttachment(event, event.attachments[0])).resolves.toEqual({
      type: "data",
      data: "ZmFrZQ==",
    });
    expect(fake.downloadFile).toHaveBeenCalledWith("photo-id", undefined);
  });

  it("validates addresses, text limits, polling options, and lifecycle", async () => {
    const fake = fakeApi();
    const channel = telegram({ api: fake.api });

    await expect(
      channel.send({ platform: "discord", conversationId: "1" }, { text: "hello" }),
    ).rejects.toThrow("cannot use a discord address");
    await expect(
      channel.send({ platform: "telegram", conversationId: "1" }, { text: "x".repeat(4_097) }),
    ).rejects.toThrow("must not exceed 4096");
    expect(
      channel.splitMessage({ text: "x".repeat(4_097) }).map((part) => part.text.length),
    ).toEqual([4_096, 1]);
    expect(() => telegram({ api: fake.api, polling: { limit: 101 } })).toThrow(
      "must be an integer between 1 and 100",
    );

    fake.getUpdates.mockImplementation(waitForAbort);
    await channel.start(async () => undefined);
    await expect(channel.start(async () => undefined)).rejects.toThrow("already running");
    await channel.stop();
    await channel.stop();
  });
});

type FakeApi = Readonly<{
  api: TelegramBotApi;
  getMe: ReturnType<typeof vi.fn<TelegramBotApi["getMe"]>>;
  getUpdates: ReturnType<typeof vi.fn<TelegramBotApi["getUpdates"]>>;
  sendMessage: ReturnType<typeof vi.fn<TelegramBotApi["sendMessage"]>>;
  sendAttachment: ReturnType<typeof vi.fn<TelegramBotApi["sendAttachment"]>>;
  editMessageText: ReturnType<typeof vi.fn<TelegramBotApi["editMessageText"]>>;
  answerCallbackQuery: ReturnType<typeof vi.fn<TelegramBotApi["answerCallbackQuery"]>>;
  deleteMessage: ReturnType<typeof vi.fn<TelegramBotApi["deleteMessage"]>>;
  sendChatAction: ReturnType<typeof vi.fn<TelegramBotApi["sendChatAction"]>>;
  setMessageReaction: ReturnType<typeof vi.fn<TelegramBotApi["setMessageReaction"]>>;
  downloadFile: ReturnType<typeof vi.fn<TelegramBotApi["downloadFile"]>>;
}>;

function fakeApi(): FakeApi {
  const getMe = vi.fn<TelegramBotApi["getMe"]>().mockResolvedValue(bot);
  const getUpdates = vi.fn<TelegramBotApi["getUpdates"]>();
  const sendMessage = vi
    .fn<TelegramBotApi["sendMessage"]>()
    .mockResolvedValue(sentTelegramMessage());
  const sendAttachment = vi
    .fn<TelegramBotApi["sendAttachment"]>()
    .mockResolvedValue(sentTelegramMessage());
  const editMessageText = vi
    .fn<TelegramBotApi["editMessageText"]>()
    .mockResolvedValue(sentTelegramMessage());
  const answerCallbackQuery = vi
    .fn<TelegramBotApi["answerCallbackQuery"]>()
    .mockResolvedValue(true);
  const deleteMessage = vi.fn<TelegramBotApi["deleteMessage"]>().mockResolvedValue(true);
  const sendChatAction = vi.fn<TelegramBotApi["sendChatAction"]>().mockResolvedValue(true);
  const setMessageReaction = vi.fn<TelegramBotApi["setMessageReaction"]>().mockResolvedValue(true);
  const downloadFile = vi.fn<TelegramBotApi["downloadFile"]>().mockResolvedValue({
    type: "data",
    data: "ZmFrZQ==",
  });
  return {
    api: {
      getMe,
      getUpdates,
      sendMessage,
      sendAttachment,
      editMessageText,
      answerCallbackQuery,
      deleteMessage,
      sendChatAction,
      setMessageReaction,
      downloadFile,
    },
    getMe,
    getUpdates,
    sendMessage,
    sendAttachment,
    editMessageText,
    answerCallbackQuery,
    deleteMessage,
    sendChatAction,
    setMessageReaction,
    downloadFile,
  };
}

function textUpdate(updateId: number, options: { sender?: TelegramUser } = {}): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: options.sender ?? {
        id: 7,
        is_bot: false,
        first_name: "Indra",
      },
      chat: { id: -100, type: "supergroup" },
      text: "hello",
    },
  };
}

function sentTelegramMessage(): TelegramMessage {
  return {
    message_id: 77,
    message_thread_id: 9,
    from: bot,
    chat: { id: -100, type: "supergroup" },
    text: "alert",
  };
}

function waitForAbort(
  _request: Parameters<TelegramBotApi["getUpdates"]>[0],
  signal?: AbortSignal,
): Promise<TelegramUpdateBatch> {
  return new Promise<TelegramUpdateBatch>((resolve) => {
    if (signal?.aborted === true) {
      resolve({ updates: [], invalid: [] });
      return;
    }
    signal?.addEventListener("abort", () => resolve({ updates: [], invalid: [] }), { once: true });
  });
}
