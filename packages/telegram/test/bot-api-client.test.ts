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
