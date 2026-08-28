import { describe, expect, it, vi } from "vitest";
import { TelegramApiError, createTelegramBotApiClient } from "../src/index.js";

describe("Telegram Bot API client", () => {
  it("posts JSON requests and validates successful results", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: {
          id: 42,
          is_bot: true,
          first_name: "Anvia",
          username: "anvia_bot",
        },
      }),
    );
    const api = createTelegramBotApiClient({
      token: "123:test-token",
      fetch,
    });

    await expect(api.getMe()).resolves.toMatchObject({ id: 42, username: "anvia_bot" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.telegram.org/bot123:test-token/getMe");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: "{}",
    });
  });

  it("returns runtime-validated updates", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: [
          {
            update_id: 10,
            message: {
              message_id: 7,
              message_thread_id: 3,
              from: { id: 5, is_bot: false, first_name: "Indra" },
              chat: { id: -100, type: "supergroup", title: "Anvia" },
              text: "hello",
            },
          },
        ],
      }),
    );
    const api = createTelegramBotApiClient({ token: "123:test-token", fetch });

    await expect(
      api.getUpdates({ offset: 10, timeout: 30, allowed_updates: ["message"] }),
    ).resolves.toEqual([
      {
        update_id: 10,
        message: {
          message_id: 7,
          message_thread_id: 3,
          from: { id: 5, is_bot: false, first_name: "Indra" },
          chat: { id: -100, type: "supergroup", title: "Anvia" },
          text: "hello",
        },
      },
    ]);
  });

  it("runtime-validates media fields returned by getUpdates", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: [
          {
            update_id: 10,
            message: {
              message_id: 7,
              chat: { id: 5, type: "private" },
              photo: [{ file_id: "photo-id", width: 10, height: 20, file_size: 30 }],
              document: {
                file_id: "document-id",
                file_name: "brief.pdf",
                mime_type: "application/pdf",
                file_size: 40,
              },
            },
          },
        ],
      }),
    );
    const api = createTelegramBotApiClient({ token: "123:test-token", fetch });

    await expect(api.getUpdates({})).resolves.toMatchObject([
      {
        message: {
          photo: [{ file_id: "photo-id", width: 10, height: 20, file_size: 30 }],
          document: { file_id: "document-id", file_size: 40 },
        },
      },
    ]);
  });

  it("runtime-validates and acknowledges callback queries", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: [
            {
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
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const api = createTelegramBotApiClient({ token: "123:test-token", fetch });

    await expect(api.getUpdates({ allowed_updates: ["callback_query"] })).resolves.toMatchObject([
      {
        callback_query: {
          id: "callback-1",
          data: "anvia:token:approve",
          from: { id: 7 },
          message: { message_id: 77 },
        },
      },
    ]);
    await expect(api.answerCallbackQuery({ callback_query_id: "callback-1" })).resolves.toBe(true);
    expect(fetch.mock.calls[1]?.[0]).toContain("/answerCallbackQuery");
  });

  it.each([
    ["empty file ID", { file_id: "", width: 10, height: 20 }, "file_id was empty"],
    ["negative width", { file_id: "photo-id", width: -1, height: 20 }, "positive integer"],
    [
      "negative file size",
      { file_id: "photo-id", width: 10, height: 20, file_size: -1 },
      "nonnegative integer",
    ],
  ])("rejects media with an %s", async (_case, photo, message) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: [
          {
            update_id: 10,
            message: {
              message_id: 7,
              chat: { id: 5, type: "private" },
              photo: [photo],
            },
          },
        ],
      }),
    );
    const api = createTelegramBotApiClient({ token: "123:test-token", fetch });

    await expect(api.getUpdates({})).rejects.toThrow(message);
  });

  it("downloads files without exposing the authenticated URL to callers", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "photos/file_1.jpg" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const api = createTelegramBotApiClient({ token: "123:test-token", fetch });

    await expect(api.downloadFile("photo-id")).resolves.toEqual({
      type: "data",
      data: "AQID",
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.telegram.org/bot123:test-token/getFile");
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.telegram.org/file/bot123:test-token/photos/file_1.jpg",
    );
  });

  it("rejects a declared file size before downloading", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: { file_path: "photos/file_1.jpg", file_size: 3 },
      }),
    );
    const api = createTelegramBotApiClient({
      token: "123:test-token",
      fetch,
      maximumAttachmentBytes: 2,
    });

    await expect(api.downloadFile("photo-id")).rejects.toThrow("must not exceed 2 bytes");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("caps streamed downloads when content-length is unavailable", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "file.bin" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const api = createTelegramBotApiClient({
      token: "123:test-token",
      fetch,
      maximumAttachmentBytes: 2,
    });

    await expect(api.downloadFile("file-id")).rejects.toThrow("must not exceed 2 bytes");
  });

  it("exposes Telegram error details without including the token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 3 },
        },
        429,
      ),
    );
    const api = createTelegramBotApiClient({ token: "123:super-secret", fetch });

    const error = await api.getUpdates({}).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({
      method: "getUpdates",
      errorCode: 429,
      retryAfterSeconds: 3,
    });
    expect(String(error)).not.toContain("super-secret");
  });

  it("does not expose a token embedded in a network error", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(
        new Error("fetch failed for https://api.telegram.org/bot123:super-secret/getMe"),
      );
    const api = createTelegramBotApiClient({ token: "123:super-secret", fetch });

    const error = await api.getMe().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ message: "Telegram getMe failed: request failed" });
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("super-secret");
  });

  it("rejects malformed success responses", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, result: { id: "not-a-number" } }));
    const api = createTelegramBotApiClient({ token: "123:test-token", fetch });

    await expect(api.getMe()).rejects.toThrow("getMe result.id was not a safe integer");
  });

  it("allows HTTP only for local Bot API servers", () => {
    expect(() =>
      createTelegramBotApiClient({ token: "123:test", baseUrl: "http://example.com" }),
    ).toThrow("must use HTTPS");
    expect(() =>
      createTelegramBotApiClient({ token: "123:test", baseUrl: "http://127.0.0.1:8081" }),
    ).not.toThrow();
  });

  it("rejects malformed bot tokens before making a request", () => {
    expect(() => createTelegramBotApiClient({ token: "not-a-token" })).toThrow(
      "bot token is invalid",
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
