import type { AgentOutcome } from "@anvia/core";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryChannelAgentInteractionStore,
  channelInteractionKey,
  serveChannelAgent,
} from "../src/index.js";
import type { ChannelAgentExecutor } from "../src/index.js";
import {
  FakeChannel,
  agentApproval,
  agentResponse,
  deferred,
  messageEvent,
  textStream,
} from "./helpers.js";

function agent(generate: ChannelAgentExecutor["generate"]): ChannelAgentExecutor {
  return {
    model: { capabilities: { streaming: false } },
    generate,
    stream: () => ({ textStream: textStream(), result: Promise.resolve(agentResponse("unused")) }),
  };
}

describe("agent run timeout boundaries", () => {
  it("keeps a conversation serialized when preparation consumes most of the timeout", async () => {
    vi.useFakeTimers();
    try {
      const channel = new FakeChannel();
      const prompt = deferred<string>();
      const outcome = deferred<AgentOutcome<string>>();
      const generate = vi
        .fn<ChannelAgentExecutor["generate"]>()
        .mockReturnValueOnce(outcome.promise)
        .mockResolvedValue(agentResponse("second done"));
      const service = await serveChannelAgent({
        channel,
        agent: agent(generate),
        createPrompt: ({ event }) => (event.id === "first" ? prompt.promise : event.text),
        streaming: { placeholder: false },
        runTimeoutMs: 1_000,
      });

      const first = channel.emit(messageEvent({ id: "first" }));
      await vi.advanceTimersByTimeAsync(900);
      prompt.resolve("first");
      await vi.advanceTimersByTimeAsync(0);
      expect(generate).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(101);
      const second = channel.emit(messageEvent({ id: "second", text: "second" }));
      await vi.advanceTimersByTimeAsync(0);
      const callsWhileFirstActive = generate.mock.calls.length;

      outcome.resolve(agentResponse("first done"));
      await Promise.all([first, second]);
      await service.stop();

      expect(callsWhileFirstActive).toBe(1);
      expect(channel.sent.map(({ message }) => message.text)).toEqual([
        "first done",
        "second done",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains outcome rendering and delivery after the execution timeout window", async () => {
    vi.useFakeTimers();
    try {
      const channel = new FakeChannel();
      const rendered = deferred<string>();
      const renderOutcome = vi.fn(() => rendered.promise);
      const service = await serveChannelAgent({
        channel,
        agent: agent(async () => agentResponse("done")),
        renderOutcome,
        streaming: { placeholder: false },
        runTimeoutMs: 1_000,
      });

      const run = channel.emit(messageEvent());
      await vi.advanceTimersByTimeAsync(0);
      expect(renderOutcome).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_001);
      const stopping = service.stop();
      await vi.advanceTimersByTimeAsync(0);
      const stopsBeforeDelivery = channel.stopCount;

      rendered.resolve("delivered before stopping");
      await Promise.all([run, stopping]);

      expect(stopsBeforeDelivery).toBe(0);
      expect(channel.sent.map(({ message }) => message.text)).toEqual([
        "delivered before stopping",
      ]);
      expect(channel.stopCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the execution timer when an executor throws synchronously", async () => {
    vi.useFakeTimers();
    try {
      const channel = new FakeChannel();
      const failure = new Error("synchronous executor failure");
      const onError = vi.fn();
      const service = await serveChannelAgent({
        channel,
        agent: agent(() => {
          throw failure;
        }),
        streaming: { placeholder: false },
        runTimeoutMs: 1_000,
        onError,
      });

      await channel.emit(messageEvent());
      await service.stop();

      expect(onError).toHaveBeenCalledWith(failure, expect.objectContaining({ stage: "agent" }));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores a timed-out interaction resume so a later reply can retry", async () => {
    vi.useFakeTimers();
    try {
      const channel = new FakeChannel();
      const store = new MemoryChannelAgentInteractionStore();
      const resume = vi
        .fn<NonNullable<ChannelAgentExecutor["resume"]>>()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValue(agentResponse("approved"));
      const onError = vi.fn();
      const service = await serveChannelAgent({
        channel,
        agent: { ...agent(async () => agentApproval()), resume },
        interactions: { store },
        streaming: { placeholder: false },
        runTimeoutMs: 1_000,
        onError,
      });
      const event = messageEvent();
      const key = channelInteractionKey(event);
      await channel.emit(event);
      const pending = await store.get(key);
      expect(pending).toBeDefined();

      const first = channel.emit(messageEvent({ id: "first-reply", text: "approve" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(resume).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      await first;

      expect(resume.mock.calls[0]?.[2].abortSignal.aborted).toBe(true);
      expect(await store.get(key)).toEqual(pending);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Channel agent run timed out" }),
        expect.objectContaining({
          stage: "agent",
          event: expect.objectContaining({ id: "first-reply" }),
        }),
      );

      await channel.emit(messageEvent({ id: "second-reply", text: "approve" }));
      await service.stop();
      expect(resume).toHaveBeenCalledTimes(2);
      expect(await store.get(key)).toBeUndefined();
      expect(channel.sent.at(-1)?.message.text).toBe("approved");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
