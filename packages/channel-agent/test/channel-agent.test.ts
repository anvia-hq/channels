import type { Agent, AgentOutcome } from "@anvia/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createChannelAgent, serveChannelAgent } from "../src/index.js";
import type { ChannelAgentExecutor, ChannelAgentRunInput } from "../src/index.js";
import { FakeChannel, agentResponse, deferred, messageEvent, textStream } from "./helpers.js";

describe("ChannelAgentService", () => {
  it("runs an agent with the default prompt and memory scope", async () => {
    const channel = new FakeChannel();
    const generate = vi
      .fn<ChannelAgentExecutor["generate"]>()
      .mockResolvedValue(agentResponse("hello back"));
    const agent = fakeAgent({ generate, streaming: false });
    const service = createChannelAgent({ channel, agent });

    await service.start();
    await channel.emit(messageEvent());

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      prompt: "hello",
      session: {
        sessionId: "channel:telegram:42:chat-1:root",
        userId: "telegram:user-1",
      },
      abortSignal: expect.any(AbortSignal),
    });
    expect(channel.sent.map((item) => item.message.text)).toEqual(["Thinking…"]);
    expect(channel.edits.map((item) => item.message.text)).toEqual(["hello back"]);

    await service.stop();
  });

  it("filters unmentioned group messages by default", async () => {
    const channel = new FakeChannel();
    const generate = vi
      .fn<ChannelAgentExecutor["generate"]>()
      .mockResolvedValue(agentResponse("handled"));
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent({ generate, streaming: false }),
      streaming: { placeholder: false },
    });

    await channel.emit(messageEvent({ conversation: { id: "group", kind: "group" } }));
    await channel.emit(
      messageEvent({
        id: "event-2",
        conversation: { id: "group", kind: "group" },
        mentionedBot: true,
      }),
    );

    expect(generate).toHaveBeenCalledOnce();
    expect(channel.sent.map((item) => item.message.text)).toEqual(["handled"]);
    expect(channel.startCount).toBe(1);

    await service.stop();
  });

  it("streams progressive edits and avoids a duplicate final edit", async () => {
    const channel = new FakeChannel();
    const stream = vi.fn<ChannelAgentExecutor["stream"]>().mockReturnValue({
      textStream: textStream("hel", "lo"),
      result: Promise.resolve(agentResponse("hello")),
    });
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent({ stream, streaming: true }),
      streaming: { editIntervalMs: 0 },
    });

    await channel.emit(messageEvent());

    expect(stream).toHaveBeenCalledOnce();
    expect(channel.sent.map((item) => item.message.text)).toEqual(["Thinking…"]);
    expect(channel.edits.map((item) => item.message.text)).toEqual(["hel", "hello"]);

    await service.stop();
  });

  it("can buffer a stream and send only the final response", async () => {
    const channel = new FakeChannel();
    const stream = vi.fn<ChannelAgentExecutor["stream"]>().mockReturnValue({
      textStream: textStream("hel", "lo"),
      result: Promise.resolve(agentResponse("hello")),
    });
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent({ stream, streaming: true }),
      streaming: { placeholder: false },
    });

    await channel.emit(messageEvent());

    expect(channel.sent.map((item) => item.message.text)).toEqual(["hello"]);
    expect(channel.edits).toEqual([]);

    await service.stop();
  });

  it("supports custom prompts, sessions, and outcome rendering", async () => {
    const channel = new FakeChannel();
    const generate = vi
      .fn<ChannelAgentExecutor<{ answer: number }>["generate"]>()
      .mockResolvedValue(agentResponse("raw", { answer: 42 }));
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent<{ answer: number }>({ generate, streaming: false }),
      streaming: { placeholder: false },
      createPrompt: (event) => `Channel message: ${event.text}`,
      createSession: () => ({ sessionId: "custom", userId: "custom-user" }),
      renderOutcome: (outcome) =>
        outcome.type === "response" ? String(outcome.output.answer) : outcome.text,
    });

    await channel.emit(messageEvent());

    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Channel message: hello",
      session: { sessionId: "custom", userId: "custom-user" },
    });
    expect(channel.sent.map((item) => item.message.text)).toEqual(["42"]);

    await service.stop();
  });

  it("serializes runs per conversation while allowing unrelated conversations", async () => {
    const channel = new FakeChannel();
    const first = deferred<AgentOutcome<string>>();
    const second = deferred<AgentOutcome<string>>();
    const other = deferred<AgentOutcome<string>>();
    const outcomes = new Map([
      ["first", first],
      ["second", second],
      ["other", other],
    ]);
    const generate = vi.fn((input: ChannelAgentRunInput) => {
      const pending = outcomes.get(String(input.prompt));
      if (pending === undefined) throw new Error("Unexpected prompt");
      return pending.promise;
    });
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent({ generate, streaming: false }),
      streaming: { placeholder: false },
    });

    const firstRun = channel.emit(messageEvent({ id: "1", text: "first" }));
    const secondRun = channel.emit(messageEvent({ id: "2", text: "second" }));
    const otherRun = channel.emit(
      messageEvent({
        id: "3",
        text: "other",
        conversation: { id: "chat-2", kind: "direct" },
      }),
    );
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls.map((call) => call[0].prompt)).toEqual(["first", "other"]);

    first.resolve(agentResponse("first done"));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
    expect(generate.mock.calls[2]?.[0].prompt).toBe("second");

    other.resolve(agentResponse("other done"));
    second.resolve(agentResponse("second done"));
    await Promise.all([firstRun, secondRun, otherRun]);

    await service.stop();
  });

  it("reports agent failures and replaces the placeholder with an error", async () => {
    const channel = new FakeChannel();
    const error = new Error("model unavailable");
    const generate = vi.fn<ChannelAgentExecutor["generate"]>().mockRejectedValue(error);
    const onError = vi.fn();
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent({ generate, streaming: false }),
      onError,
    });
    const event = messageEvent();

    await channel.emit(event);

    expect(onError).toHaveBeenCalledWith(error, { stage: "agent", event });
    expect(channel.edits.map((item) => item.message.text)).toEqual([
      "Sorry, I couldn't process that message.",
    ]);

    await service.stop();
  });

  it("aborts and drains in-flight agent work during shutdown", async () => {
    const channel = new FakeChannel();
    let runSignal: AbortSignal | undefined;
    const generate = vi.fn((input: ChannelAgentRunInput) => {
      runSignal = input.abortSignal;
      return new Promise<AgentOutcome<string>>((_resolve, reject) => {
        input.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    const onError = vi.fn();
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent({ generate, streaming: false }),
      streaming: { placeholder: false },
      onError,
    });

    const run = channel.emit(messageEvent());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    await service.stop();
    await run;

    expect(runSignal?.aborted).toBe(true);
    expect(channel.sent).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(channel.stopCount).toBe(1);
  });

  it("validates options and lifecycle", async () => {
    const channel = new FakeChannel();
    const agent = fakeAgent({ streaming: false });

    expect(() => createChannelAgent({ channel, agent, streaming: { editIntervalMs: -1 } })).toThrow(
      "edit interval must be a nonnegative integer",
    );
    expect(() => createChannelAgent({ channel, agent, streaming: { placeholder: "" } })).toThrow(
      "placeholder must not be empty",
    );

    const service = createChannelAgent({ channel, agent });
    await service.start();
    await expect(service.start()).rejects.toThrow("already running");
    await service.stop();
    await service.stop();
  });

  it("can restart after the channel fails to stop", async () => {
    const channel = new FakeChannel();
    const service = createChannelAgent({
      channel,
      agent: fakeAgent({ streaming: false }),
    });
    await service.start();
    channel.stopError = new Error("stop failed");

    await expect(service.stop()).rejects.toThrow("stop failed");

    channel.stopError = undefined;
    await service.start();
    expect(channel.startCount).toBe(2);
    await service.stop();
  });

  it("accepts the public Anvia Agent shape", () => {
    expectTypeOf<Agent>().toExtend<ChannelAgentExecutor<string>>();
  });
});

type FakeAgentOptions<Output> = Readonly<{
  generate?: ChannelAgentExecutor<Output>["generate"];
  stream?: ChannelAgentExecutor<Output>["stream"];
  streaming: boolean;
}>;

function fakeAgent<Output = string>(
  options: FakeAgentOptions<Output>,
): ChannelAgentExecutor<Output> {
  return {
    model: { capabilities: { streaming: options.streaming } },
    generate: options.generate ?? (async () => agentResponse<Output>("generated")),
    stream:
      options.stream ??
      (() => ({
        textStream: textStream("streamed"),
        result: Promise.resolve(agentResponse<Output>("streamed")),
      })),
  };
}
