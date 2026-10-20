import { describe, expect, it, vi } from "vitest";
import { PartialDeliveryError } from "@anvia/channel";
import { serveChannelAgent } from "../src/index.js";
import type { ChannelAgentExecutor } from "../src/index.js";
import { FakeChannel, agentResponse, messageEvent, textStream } from "./helpers.js";

function fakeAgent(): ChannelAgentExecutor<string> {
  return {
    model: { capabilities: { streaming: false } },
    generate: async () => agentResponse("unused"),
    stream: () => ({
      textStream: textStream("unused"),
      result: Promise.resolve(agentResponse("unused")),
    }),
  };
}

describe("ChannelAgentService placeholder partial delivery", () => {
  it("deletes the streaming placeholder when attachment delivery partially fails", async () => {
    const channel = new FakeChannel();
    const onError = vi.fn();
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent(),
      streaming: { enabled: false },
      renderOutcome: () => ({
        text: "report",
        attachments: [
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "report.pdf",
            source: { type: "data", data: "cGRm" },
          },
        ],
      }),
      onError,
    });

    const originalSend = channel.send.bind(channel);
    let sendCalls = 0;
    vi.spyOn(channel, "send").mockImplementation(async (address, message) => {
      sendCalls += 1;
      // The first send is the streaming placeholder; it must succeed so a
      // provisional message exists when the attachment delivery fails.
      if (sendCalls === 1) return originalSend(address, message);
      throw new Error("attachment part failed");
    });

    const event = messageEvent();
    await channel.emit(event);

    expect(channel.deleted.map((message) => message.id)).toEqual(["1"]);
    expect(channel.deleted).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(PartialDeliveryError),
      expect.objectContaining({ stage: "delivery" }),
    );
    await service.stop();
  });
});
