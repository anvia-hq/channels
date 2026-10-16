import { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackFileDeliveryError, slack } from "../src/index.js";

const address = { platform: "slack", conversationId: "C1" };
const timestamp = "1700000001.000002";
const attachment = {
  type: "file" as const,
  mediaType: "text/plain",
  filename: "report.txt",
  source: { type: "data" as const, data: "aGk=" },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  let nextFile = 0;
  const api = vi.spyOn(WebClient.prototype, "apiCall").mockImplementation(async (method) => {
    switch (method) {
      case "chat.postMessage":
        return { ok: true, channel: "C1", ts: timestamp };
      case "files.getUploadURLExternal":
        nextFile += 1;
        return { ok: true, file_id: `F${nextFile}`, upload_url: "https://files.slack.com/upload" };
      case "files.completeUploadExternal":
        return { ok: true, files: [{ id: "F1" }, { id: "F2" }] };
      case "files.info":
        return { ok: true, file: { shares: { private: { C1: [{ ts: timestamp }] } } } };
      default:
        return { ok: true };
    }
  });
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response("ok"));
  const options = { appToken: "xapp-test", botToken: "xoxb-test", fetch };
  return { api, fetch, options, channel: slack(options) };
}

describe("Slack file delivery", () => {
  it("validates all attachment sizes before posting any text", async () => {
    const { api, options } = fixture();
    const channel = slack({ ...options, maximumAttachmentBytes: 1 });
    await expect(
      channel.send(address, {
        text: "report",
        attachments: [{ ...attachment, source: { type: "data", data: "YQ==" } }, attachment],
      }),
    ).rejects.toThrow("must not exceed 1 bytes");
    expect(api).not.toHaveBeenCalled();
  });

  it("publishes files and sanitized text together and deletes them from a restored handle", async () => {
    const { api, channel, options } = fixture();
    const sent = await channel.send(address, {
      text: "report <!channel>",
      attachments: [attachment, attachment],
    });
    expect(api).not.toHaveBeenCalledWith("chat.postMessage", expect.anything());
    expect(api).toHaveBeenCalledWith(
      "files.completeUploadExternal",
      expect.objectContaining({
        channel_id: "C1",
        initial_comment: "report &lt;!channel&gt;",
        files: [
          { id: "F1", title: "report.txt" },
          { id: "F2", title: "report.txt" },
        ],
      }),
    );
    api.mockClear();
    await slack(options).delete(JSON.parse(JSON.stringify(sent)));
    expect(api).toHaveBeenCalledWith("files.delete", { file: "F1" });
    expect(api).toHaveBeenCalledWith("files.delete", { file: "F2" });
    expect(api).toHaveBeenCalledWith("chat.delete", { channel: "C1", ts: timestamp });
  });
  it("does not duplicate text when a later upload fails and the caller retries", async () => {
    const { api, fetch, channel } = fixture();
    fetch
      .mockResolvedValueOnce(new Response("ok"))
      .mockResolvedValueOnce(new Response("failed", { status: 500 }));
    const message = { text: "report", attachments: [attachment, attachment] };
    await expect(channel.send(address, message)).rejects.toThrow("HTTP 500");
    expect(api).not.toHaveBeenCalledWith("files.completeUploadExternal", expect.anything());
    expect(api).toHaveBeenCalledWith("files.delete", { file: "F1" });
    expect(api).toHaveBeenCalledWith("files.delete", { file: "F2" });
    await channel.send(address, message);
    expect(
      api.mock.calls.filter(([method]) => method === "files.completeUploadExternal"),
    ).toHaveLength(1);
    expect(api).not.toHaveBeenCalledWith("chat.postMessage", expect.anything());
  });

  it("retries transient share lookup failures and delayed visibility without rolling back", async () => {
    vi.useFakeTimers();
    const { api, channel } = fixture();
    const normal = api.getMockImplementation()!;
    let lookups = 0;
    api.mockImplementation(async (method, options) => {
      if (method === "files.info") {
        lookups += 1;
        if (lookups === 1) throw new Error("temporary API failure");
        if (lookups === 2) return { ok: true, file: {} };
      }
      return normal(method, options);
    });
    const sent = channel.send(address, { text: "report", attachments: [attachment] });
    const assertion = expect(sent).resolves.toMatchObject({ address });
    await vi.runAllTimersAsync();
    await assertion;
    expect(lookups).toBe(3);
    expect(api).not.toHaveBeenCalledWith("files.delete", expect.anything());
    expect(api).not.toHaveBeenCalledWith("chat.delete", expect.anything());
  });

  it("recovers the share from another file when completion's response is lost", async () => {
    const { api, channel } = fixture();
    const normal = api.getMockImplementation()!;
    const failure = new Error("completion response lost");
    api.mockImplementation(async (method, options) => {
      if (method === "files.completeUploadExternal") throw failure;
      if (method === "files.info" && options?.file === "F1") return { ok: true, file: {} };
      return normal(method, options);
    });
    await expect(
      channel.send(address, { text: "report", attachments: [attachment, attachment] }),
    ).rejects.toBe(failure);
    expect(api).toHaveBeenCalledWith("files.info", { file: "F2" });
    expect(api).toHaveBeenCalledWith("chat.delete", { channel: "C1", ts: timestamp });
    expect(api).toHaveBeenCalledWith("files.delete", { file: "F1" });
    expect(api).toHaveBeenCalledWith("files.delete", { file: "F2" });
  });

  it.each([false, true])(
    "retains a cleanup path after lookup exhaustion (lost completion: %s)",
    async (lostCompletion) => {
      vi.useFakeTimers();
      const { api, channel } = fixture();
      const normal = api.getMockImplementation()!;
      api.mockImplementation(async (method, options) => {
        if (method === "files.completeUploadExternal" && lostCompletion)
          throw new Error("response lost");
        if (method === "files.info") throw new Error("lookup unavailable");
        return normal(method, options);
      });
      const result = channel
        .send(address, { text: "report", attachments: [attachment] })
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await result;
      expect(error).toBeInstanceOf(SlackFileDeliveryError);
      expect(
        api.mock.calls.filter(([method]) => method === "files.info").length,
      ).toBeLessThanOrEqual(8);
      expect(api).not.toHaveBeenCalledWith("files.delete", expect.anything());
      expect(api).not.toHaveBeenCalledWith("chat.delete", expect.anything());
      if (!(error instanceof SlackFileDeliveryError)) throw new Error("Expected recovery error");
      api.mockImplementation(normal);
      await error.retryCleanup();
      const calls = api.mock.calls.map(([method]) => method);
      expect(calls.indexOf("chat.delete")).toBeLessThan(calls.indexOf("files.delete"));
      expect(api).toHaveBeenCalledWith("files.delete", { file: "F1" });
    },
  );

  it("retains the resolved timestamp when message cleanup fails and files are deleted", async () => {
    const { api, channel } = fixture();
    const normal = api.getMockImplementation()!;
    api.mockImplementation(async (method, options) => {
      if (method === "files.completeUploadExternal") throw new Error("response lost");
      if (method === "chat.delete") throw new Error("deletion unavailable");
      return normal(method, options);
    });
    const error: unknown = await channel
      .send(address, { text: "report", attachments: [attachment] })
      .catch((error: unknown) => error);
    expect(api).toHaveBeenCalledWith("files.delete", { file: "F1" });
    if (!(error instanceof SlackFileDeliveryError)) throw new Error("Expected recovery error");
    api.mockClear();
    api.mockImplementation(async (method, options) => {
      if (method === "files.info" || method === "files.delete") throw missing("file_not_found");
      return normal(method, options);
    });
    await error.retryCleanup();
    expect(api).not.toHaveBeenCalledWith("files.info", expect.anything());
    expect(api).toHaveBeenCalledWith("chat.delete", { channel: "C1", ts: timestamp });
  });

  it("reports cleanup failures while attempting every file", async () => {
    const { api, fetch, channel } = fixture();
    const normal = api.getMockImplementation()!;
    fetch
      .mockResolvedValueOnce(new Response("ok"))
      .mockRejectedValueOnce(new Error("signed URL must stay private"));
    api.mockImplementation(async (method, options) => {
      if (method === "files.delete" && options?.file === "F1") throw new Error("cleanup failed");
      return normal(method, options);
    });
    await expect(
      channel.send(address, { text: "report", attachments: [attachment, attachment] }),
    ).rejects.toMatchObject({
      message: "Slack file delivery failed and cleanup was incomplete",
      errors: [
        expect.objectContaining({ message: "Slack file upload failed" }),
        expect.objectContaining({ message: "cleanup failed" }),
      ],
    });
    expect(api).toHaveBeenCalledWith("files.delete", { file: "F2" });
  });

  it("preserves threads, action blocks, edits, reactions, and reply handles", async () => {
    const { api, channel } = fixture();
    const normal = api.getMockImplementation()!;
    const thread = "1700000000.000001";
    api.mockImplementation(async (method, options) =>
      method === "files.info"
        ? { ok: true, file: { shares: { public: { C1: [{ ts: timestamp, thread_ts: thread }] } } } }
        : normal(method, options),
    );
    const sent = await channel.send(
      { ...address, threadId: thread },
      {
        text: "Review <!here>",
        attachments: [attachment],
        actions: [{ id: "approve", label: "Approve" }],
      },
    );
    expect(sent.address.threadId).toBe(thread);
    const completion = api.mock.calls.find(
      ([method]) => method === "files.completeUploadExternal",
    )?.[1];
    expect(completion).toMatchObject({
      thread_ts: thread,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Review &lt;!here&gt;" } },
        { type: "actions", elements: [expect.objectContaining({ action_id: "approve" })] },
      ],
    });
    expect(completion).not.toHaveProperty("initial_comment");
    await channel.edit(sent, { text: "Done" });
    await channel.react(sent, "eyes");
    await channel.unreact(sent, "eyes");
    await channel.send(address, { text: "reply", replyToMessageId: sent.id });
    expect(api).toHaveBeenCalledWith("chat.update", expect.objectContaining({ ts: timestamp }));
    expect(api).toHaveBeenCalledWith("reactions.add", { channel: "C1", timestamp, name: "eyes" });
    expect(api).toHaveBeenCalledWith("reactions.remove", {
      channel: "C1",
      timestamp,
      name: "eyes",
    });
    expect(api).toHaveBeenCalledWith(
      "chat.postMessage",
      expect.objectContaining({ thread_ts: timestamp }),
    );
  });

  it("supports file-only messages and rejects invalid share responses with cleanup", async () => {
    vi.useFakeTimers();
    const { api, channel } = fixture();
    await channel.send(address, { text: "", attachments: [attachment] });
    expect(api).toHaveBeenCalledWith(
      "files.completeUploadExternal",
      expect.objectContaining({ initial_comment: "\u200b" }),
    );
    const normal = api.getMockImplementation()!;
    api.mockImplementation(async (method, options) =>
      method === "files.info"
        ? { ok: true, file: { shares: { public: { C2: [{ ts: timestamp }] } } } }
        : normal(method, options),
    );
    const assertion = expect(
      channel.send(address, { text: "", attachments: [attachment] }),
    ).rejects.toMatchObject({
      message: "Slack file delivery failed and cleanup was incomplete",
      errors: [
        expect.objectContaining({ message: "Slack uploaded file share timestamp is unavailable" }),
        expect.objectContaining({ message: "Slack uploaded file share timestamp is unavailable" }),
      ],
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(api).not.toHaveBeenCalledWith("files.delete", { file: "F2" });
  });

  it.each(["file_not_found", "file_deleted"])(
    "retries partial deletion when Slack reports %s for a removed file",
    async (missingCode) => {
      const { api, channel } = fixture();
      const sent = await channel.send(address, {
        text: "report",
        attachments: [attachment, attachment],
      });
      let failed = false;
      const deleted = new Set<string>();
      api.mockImplementation(async (method, options) => {
        if (method === "files.delete") {
          const id = String(options?.file);
          if (id === "F2" && !failed) {
            failed = true;
            throw new Error("try again");
          }
          if (deleted.has(id)) throw missing(missingCode);
          deleted.add(id);
        }
        if (method === "chat.delete") throw missing("message_not_found");
        return { ok: true };
      });
      await expect(channel.delete(sent)).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: "try again" })],
      });
      expect(api).toHaveBeenCalledWith("chat.delete", expect.anything());
      await channel.delete(sent);
      expect([...deleted]).toEqual(["F1", "F2"]);
    },
  );

  it("rejects malformed file handles before issuing API requests", async () => {
    const { api, channel } = fixture();
    await expect(channel.delete({ address, id: `${timestamp}:C1` })).rejects.toThrow(
      "Slack message ID",
    );
    expect(api).not.toHaveBeenCalled();
  });
});

function missing(error: string) {
  return Object.assign(new Error(error), { code: "slack_webapi_platform_error", data: { error } });
}
