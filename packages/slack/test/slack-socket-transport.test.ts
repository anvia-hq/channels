import { describe, expect, it, vi } from "vitest";
import { SlackSocketTransport } from "../src/index.js";
import type { SlackWebClient } from "../src/index.js";
import { slackMessageBody } from "../src/slack-socket-transport.js";

describe("SlackSocketTransport Web API delivery", () => {
  it("posts and edits thread messages while neutralizing Slack control mentions", async () => {
    const fake = fakeWebClient();
    fake.postMessage.mockResolvedValue({
      ok: true,
      channel: "C1",
      ts: "1700000001.000002",
      message: { thread_ts: "1700000000.000001" },
    });
    const transport = new SlackSocketTransport(tokens(), fake.web);

    await expect(
      transport.send("C1", "1700000000.000001", {
        text: "hello <@U1> <!channel> <https://example.com>",
      }),
    ).resolves.toEqual({
      channelId: "C1",
      timestamp: "1700000001.000002",
      threadTimestamp: "1700000000.000001",
    });
    expect(fake.postMessage).toHaveBeenCalledWith("C1", "1700000000.000001", {
      text: "hello &lt;@U1&gt; &lt;!channel&gt; <https://example.com>",
    });

    await transport.edit("C1", "1700000001.000002", { text: "updated <!here>" });
    expect(fake.updateMessage).toHaveBeenCalledWith("C1", "1700000001.000002", {
      text: "updated &lt;!here&gt;",
    });
    expect(
      slackMessageBody({
        text: "Approve?",
        actions: [
          { id: "anvia:token:approve", label: "Approve", style: "primary" },
          { id: "anvia:token:deny", label: "Deny", style: "danger" },
        ],
      }),
    ).toMatchObject({
      text: "Approve?",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Approve?" } },
        {
          type: "actions",
          elements: [
            expect.objectContaining({ action_id: "anvia:token:approve", style: "primary" }),
            expect.objectContaining({ action_id: "anvia:token:deny", style: "danger" }),
          ],
        },
      ],
    });
  });

  it("rejects invalid API responses, identities, and tokens", async () => {
    const fake = fakeWebClient();
    fake.postMessage.mockResolvedValue({ ok: true });
    const transport = new SlackSocketTransport(tokens(), fake.web);

    await expect(transport.send("C1", undefined, { text: "hello" })).rejects.toThrow(
      "chat.postMessage response is invalid",
    );
    fake.authenticate.mockResolvedValue({ ok: true });
    await expect(transport.start(async () => undefined)).rejects.toThrow(
      "auth.test response is invalid",
    );
    expect(() => new SlackSocketTransport({ appToken: "", botToken: "xoxb-test" })).toThrow(
      "app-level token must not be empty",
    );
  });

  it("renders Block Kit actions with sanitized fallback text", async () => {
    const fake = fakeWebClient();
    fake.postMessage.mockResolvedValue({
      ok: true,
      channel: "C1",
      ts: "1700000001.000002",
    });
    const transport = new SlackSocketTransport(tokens(), fake.web);

    await transport.send("C1", undefined, {
      text: "Approve <@U1>?",
      actions: [
        { id: "anvia:token:approve", label: "Approve", style: "primary" },
        { id: "anvia:token:deny", label: "Deny", style: "danger" },
      ],
    });

    expect(fake.postMessage).toHaveBeenCalledWith(
      "C1",
      undefined,
      expect.objectContaining({
        text: "Approve &lt;@U1&gt;?",
        actions: expect.any(Array),
      }),
    );
  });

  it("downloads private files with bot authentication and returns base64", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const transport = new SlackSocketTransport({ ...tokens(), fetch });

    await expect(
      transport.loadAttachment({
        id: "F1",
        name: "photo.png",
        mediaType: "image/png",
        size: 3,
        privateDownloadUrl: "https://files.slack.com/photo.png",
      }),
    ).resolves.toEqual({ type: "data", data: "AQID" });
    expect(fetch).toHaveBeenCalledWith(
      "https://files.slack.com/photo.png",
      expect.objectContaining({
        headers: { authorization: "Bearer xoxb-test" },
        redirect: "error",
      }),
    );
  });

  it("rejects attachments above the configured application limit", async () => {
    const fake = fakeWebClient();
    const transport = new SlackSocketTransport(
      { ...tokens(), maximumAttachmentBytes: 2 },
      fake.web,
    );

    await expect(
      transport.loadAttachment({
        id: "F1",
        name: "photo.png",
        mediaType: "image/png",
        size: 3,
        privateDownloadUrl: "https://files.slack.com/photo.png",
      }),
    ).rejects.toThrow("must not exceed 2 bytes");
    expect(fake.downloadFile).not.toHaveBeenCalled();
  });

  it("caps streamed downloads when content-length is unavailable", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const transport = new SlackSocketTransport({
      ...tokens(),
      fetch,
      maximumAttachmentBytes: 2,
    });

    await expect(
      transport.loadAttachment({
        id: "F1",
        name: "file.bin",
        mediaType: "application/octet-stream",
        privateDownloadUrl: "https://files.slack.com/file.bin",
      }),
    ).rejects.toThrow("must not exceed 2 bytes");
  });

  it("acknowledges envelopes before handling and suppresses duplicate deliveries", async () => {
    const transport = new SlackSocketTransport(tokens(), fakeWebClient().web);
    const receive = transport as unknown as {
      receive(
        request: unknown,
        identity: Readonly<{ teamId: string; botUserId: string }>,
        handler: (message: unknown) => Promise<void>,
      ): Promise<void>;
    };
    const order: string[] = [];
    const handler = vi.fn(async () => {
      order.push("handle");
    });
    const request = {
      type: "events_api",
      body: {
        type: "event_callback",
        event_id: "Ev1",
        team_id: "T1",
        event: {
          type: "message",
          channel: "D1",
          channel_type: "im",
          user: "U1",
          text: "hello",
          ts: "1700000000.000001",
        },
      },
      ack: vi.fn(async () => {
        order.push("ack");
      }),
    };
    const identity = { teamId: "T1", botUserId: "U2" };

    await receive.receive(request, identity, handler);
    await receive.receive(request, identity, handler);

    expect(order).toEqual(["ack", "handle", "ack"]);
    expect(request.ack).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
  });
});

type FakeWebClient = Readonly<{
  web: SlackWebClient;
  authenticate: ReturnType<typeof vi.fn<SlackWebClient["authenticate"]>>;
  postMessage: ReturnType<typeof vi.fn<SlackWebClient["postMessage"]>>;
  updateMessage: ReturnType<typeof vi.fn<SlackWebClient["updateMessage"]>>;
  downloadFile: ReturnType<typeof vi.fn<SlackWebClient["downloadFile"]>>;
}>;

function fakeWebClient(): FakeWebClient {
  const authenticate = vi
    .fn<SlackWebClient["authenticate"]>()
    .mockResolvedValue({ ok: true, team_id: "T1", user_id: "U2" });
  const postMessage = vi.fn<SlackWebClient["postMessage"]>();
  const updateMessage = vi.fn<SlackWebClient["updateMessage"]>().mockResolvedValue({ ok: true });
  const downloadFile = vi.fn<SlackWebClient["downloadFile"]>().mockResolvedValue({
    type: "data",
    data: "ZmFrZQ==",
  });
  return {
    web: { authenticate, postMessage, updateMessage, downloadFile },
    authenticate,
    postMessage,
    updateMessage,
    downloadFile,
  };
}

function tokens() {
  return { appToken: "xapp-test", botToken: "xoxb-test" } as const;
}
