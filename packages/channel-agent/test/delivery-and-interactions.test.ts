import { describe, expect, it, vi } from "vitest";
import { PartialDeliveryError } from "@anvia/channel";
import { MemoryChannelAgentInteractionStore, serveChannelAgent } from "../src/index.js";
import type { ChannelAgentExecutor } from "../src/index.js";
import { FakeChannel, agentApproval, agentResponse, messageEvent, textStream } from "./helpers.js";

describe("channel agent delivery and interaction edge cases", () => {
  it("edits a streaming placeholder to attach actions even when the text matches deliveredText", async () => {
    const channel = new FakeChannel();
    const agent: ChannelAgentExecutor<string> = {
      model: { capabilities: { streaming: true } },
      generate: async () => agentResponse("Choose one"),
      stream: () => ({
        textStream: textStream("Choose one"),
        result: Promise.resolve(agentResponse("Choose one")),
      }),
    };
    const service = await serveChannelAgent({
      channel,
      agent,
      streaming: { editIntervalMs: 0, placeholder: "Working…" },
      renderOutcome: () => ({
        text: "Choose one",
        actions: [{ id: "pick:a", label: "Option A", style: "primary" }],
      }),
    });

    await channel.emit(messageEvent());
    await service.stop();

    expect(channel.edits.at(-1)?.message).toEqual({
      text: "Choose one",
      actions: [{ id: "pick:a", label: "Option A", style: "primary" }],
    });
  });

  it("wraps tail send failures after editing a placeholder in PartialDeliveryError", async () => {
    const channel = new FakeChannel(5);
    const onError = vi.fn();
    const agent: ChannelAgentExecutor<string> = {
      model: { capabilities: { streaming: false } },
      generate: async () => agentResponse("abcdefghij"),
      stream: () => ({
        textStream: textStream(),
        result: Promise.resolve(agentResponse("abcdefghij")),
      }),
    };
    const service = await serveChannelAgent({
      channel,
      agent,
      streaming: { enabled: false, placeholder: "Thinking…" },
      onError,
    });

    const originalSend = channel.send.bind(channel);
    let sendCalls = 0;
    vi.spyOn(channel, "send").mockImplementation(async (address, message) => {
      sendCalls += 1;

      if (sendCalls === 1) return originalSend(address, message);

      throw new Error("second part failed");
    });

    await channel.emit(messageEvent());
    await service.stop();

    const error = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(PartialDeliveryError);

    if (!(error instanceof PartialDeliveryError)) throw new Error("Expected PartialDeliveryError");

    expect(error.sent).toHaveLength(1);
    expect(error.failedIndex).toBe(1);
    expect(error.failedPart).toEqual({ text: "fghij" });
    expect(onError).toHaveBeenCalledWith(error, expect.objectContaining({ stage: "delivery" }));
  });

  it("reports interaction store errors during cancel through onError instead of throwing", async () => {
    const channel = new FakeChannel();
    const store = new MemoryChannelAgentInteractionStore();
    const onError = vi.fn();
    const agent: ChannelAgentExecutor<string> = {
      model: { capabilities: { streaming: false } },
      generate: async () => agentApproval(),
      stream: () => ({
        textStream: textStream(),
        result: Promise.resolve(agentApproval()),
      }),
      resume: async () => agentResponse("resumed"),
    };
    const service = await serveChannelAgent({
      channel,
      agent,
      streaming: { enabled: false, placeholder: false },
      interactions: { store },
      onError,
    });

    await channel.emit(messageEvent({ id: "first" }));
    const takeFailure = new Error("sqlite busy");
    vi.spyOn(store, "take").mockImplementation(() => {
      throw takeFailure;
    });

    await expect(
      channel.emit(messageEvent({ id: "second", text: "cancel" })),
    ).resolves.toBeUndefined();
    await service.stop();

    expect(onError).toHaveBeenCalledWith(
      takeFailure,
      expect.objectContaining({
        stage: "interaction",
        event: expect.objectContaining({ id: "second" }),
      }),
    );
  });
});
