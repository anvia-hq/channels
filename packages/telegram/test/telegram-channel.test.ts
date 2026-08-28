import { describe, expect, it, vi } from "vitest";
import { normalizeTelegramUpdate, telegram } from "../src/index.js";
import type {
  TelegramBotApi,
  TelegramMessage,
  TelegramUpdate,
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
    fake.getUpdates.mockResolvedValueOnce([update]).mockImplementation(waitForAbort);
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
      allowed_updates: ["message"],
    });
    expect(fake.getUpdates.mock.calls[1]?.[0]).toMatchObject({ offset: 11 });

    await channel.stop();
  });

  it("does not dispatch bot-authored messages", async () => {
    const fake = fakeApi();
    fake.getUpdates
      .mockResolvedValueOnce([textUpdate(1, { sender: bot }), textUpdate(2)])
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
      .mockResolvedValueOnce([update])
      .mockResolvedValueOnce([update])
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
      .mockResolvedValueOnce([textUpdate(10)])
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
    });
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
    const event = normalizeTelegramUpdate(update, bot);
    if (event === undefined || event.attachments[0] === undefined) {
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
  editMessageText: ReturnType<typeof vi.fn<TelegramBotApi["editMessageText"]>>;
  downloadFile: ReturnType<typeof vi.fn<TelegramBotApi["downloadFile"]>>;
}>;

function fakeApi(): FakeApi {
  const getMe = vi.fn<TelegramBotApi["getMe"]>().mockResolvedValue(bot);
  const getUpdates = vi.fn<TelegramBotApi["getUpdates"]>();
  const sendMessage = vi
    .fn<TelegramBotApi["sendMessage"]>()
    .mockResolvedValue(sentTelegramMessage());
  const editMessageText = vi
    .fn<TelegramBotApi["editMessageText"]>()
    .mockResolvedValue(sentTelegramMessage());
  const downloadFile = vi.fn<TelegramBotApi["downloadFile"]>().mockResolvedValue({
    type: "data",
    data: "ZmFrZQ==",
  });
  return {
    api: { getMe, getUpdates, sendMessage, editMessageText, downloadFile },
    getMe,
    getUpdates,
    sendMessage,
    editMessageText,
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
): Promise<readonly TelegramUpdate[]> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve([]);
      return;
    }
    signal?.addEventListener("abort", () => resolve([]), { once: true });
  });
}
