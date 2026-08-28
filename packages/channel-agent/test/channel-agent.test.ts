import type { Agent, AgentOutcome } from "@anvia/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  MemoryChannelAgentInteractionStore,
  channelInteractionKey,
  createChannelAgent,
  serveChannelAgent,
} from "../src/index.js";
import type { ChannelAgentExecutor, ChannelAgentRunInput } from "../src/index.js";
import {
  FakeChannel,
  agentApproval,
  agentResponse,
  deferred,
  messageEvent,
  textStream,
} from "./helpers.js";

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

  it("loads attachments into a multimodal Anvia prompt by default", async () => {
    const channel = new FakeChannel();
    channel.attachmentData.set("image-1", {
      type: "url",
      url: "https://cdn.example.test/image.png",
    });
    channel.attachmentData.set("file-1", { type: "data", data: "cGRm" });
    const loadAttachment = vi.spyOn(channel, "loadAttachment");
    const generate = vi
      .fn<ChannelAgentExecutor["generate"]>()
      .mockResolvedValue(agentResponse("I can see both attachments."));
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent({ generate, streaming: false }),
      streaming: { placeholder: false },
    });
    const event = messageEvent({
      text: "Describe these",
      attachments: [
        { id: "image-1", type: "image", mediaType: "image/png", size: 123 },
        {
          id: "file-1",
          type: "file",
          mediaType: "application/pdf",
          filename: "brief.pdf",
        },
      ],
    });

    await channel.emit(event);

    expect(generate.mock.calls[0]?.[0].prompt).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe these" },
        {
          type: "image",
          image: { type: "url", url: "https://cdn.example.test/image.png" },
          mediaType: "image/png",
        },
        {
          type: "file",
          data: { type: "data", data: "cGRm" },
          mediaType: "application/pdf",
          filename: "brief.pdf",
        },
      ],
    });
    expect(loadAttachment).toHaveBeenCalledTimes(2);
    expect(loadAttachment.mock.calls.every((call) => call[2] instanceof AbortSignal)).toBe(true);
    await service.stop();
  });

  it("rejects attachment prompts when multimodal input is disabled", async () => {
    const channel = new FakeChannel();
    const generate = vi
      .fn<ChannelAgentExecutor["generate"]>()
      .mockResolvedValue(agentResponse("unused"));
    const onError = vi.fn();
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent({ generate, streaming: false }),
      multimodal: false,
      errorMessage: false,
      onError,
    });

    await channel.emit(
      messageEvent({
        attachments: [{ id: "file-1", type: "file", mediaType: "text/plain", size: 1 }],
      }),
    );

    expect(generate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(TypeError), {
      stage: "prepare",
      event: expect.objectContaining({ id: "event-1" }),
    });
    await service.stop();
  });

  it("omits the default session for an Anvia executor without memory", async () => {
    const channel = new FakeChannel();
    const generate = vi
      .fn<ChannelAgentExecutor["generate"]>()
      .mockResolvedValue(agentResponse("hello back"));
    const agent = { ...fakeAgent({ generate, streaming: false }), memory: undefined };
    const service = await serveChannelAgent({
      channel,
      agent,
      streaming: { placeholder: false },
    });

    await channel.emit(messageEvent());

    expect(generate.mock.calls[0]?.[0]).not.toHaveProperty("session");
    expect(channel.sent.map((item) => item.message.text)).toEqual(["hello back"]);
    await service.stop();
  });

  it("delivers long responses as platform-prepared message parts", async () => {
    const channel = new FakeChannel(10);
    const generate = vi
      .fn<ChannelAgentExecutor["generate"]>()
      .mockResolvedValue(agentResponse("abcdefghijklmnopqrstu"));
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent({ generate, streaming: false }),
    });

    await channel.emit(messageEvent());

    expect(channel.edits.map((item) => item.message.text)).toEqual(["abcdefghij"]);
    expect(channel.sent.map((item) => item.message.text)).toEqual(["Thinking…", "klmnopqrst", "u"]);
    await service.stop();
  });

  it("renders channel interactions and resumes them from the sender's next reply", async () => {
    const channel = new FakeChannel();
    const generate = vi.fn<ChannelAgentExecutor["generate"]>().mockResolvedValue(agentApproval());
    const resume = vi
      .fn<NonNullable<ChannelAgentExecutor["resume"]>>()
      .mockResolvedValue(agentResponse("Email sent."));
    const agent = { ...fakeAgent({ generate, streaming: false }), resume };
    const service = await serveChannelAgent({
      channel,
      agent,
      streaming: { placeholder: false },
    });

    await channel.emit(messageEvent());
    await channel.emit(messageEvent({ id: "event-2", text: "maybe" }));
    await channel.emit(messageEvent({ id: "event-3", text: "approve" }));

    expect(channel.sent[0]?.message.text).toContain('Approve tool "send_email"?');
    expect(channel.sent[0]?.message.text).toContain('Reply "approve" or "deny".');
    expect(channel.sent[1]?.message.text).toContain("couldn't understand");
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRunId: "run-1" }),
      { type: "tool-approval", approved: true },
      { abortSignal: expect.any(AbortSignal) },
    );
    expect(channel.sent.at(-1)?.message.text).toBe("Email sent.");
    await service.stop();
  });

  it("does not treat an unrelated unmentioned group message as interaction approval", async () => {
    const channel = new FakeChannel();
    const generate = vi.fn<ChannelAgentExecutor["generate"]>().mockResolvedValue(agentApproval());
    const resume = vi
      .fn<NonNullable<ChannelAgentExecutor["resume"]>>()
      .mockResolvedValue(agentResponse("Email sent."));
    const service = await serveChannelAgent({
      channel,
      agent: { ...fakeAgent({ generate, streaming: false }), resume },
      streaming: { placeholder: false },
    });
    const group = { id: "group", kind: "group" as const };

    await channel.emit(messageEvent({ conversation: group, mentionedBot: true }));
    await channel.emit(
      messageEvent({ id: "event-2", conversation: group, text: "yes", mentionedBot: false }),
    );

    expect(resume).not.toHaveBeenCalled();

    await channel.emit(
      messageEvent({ id: "event-3", conversation: group, text: "yes", mentionedBot: true }),
    );

    expect(resume).toHaveBeenCalledOnce();
    expect(channel.sent.at(-1)?.message.text).toBe("Email sent.");
    await service.stop();
  });

  it("persists a resumed follow-up interaction when shutdown races with resume", async () => {
    const channel = new FakeChannel();
    const store = new MemoryChannelAgentInteractionStore();
    const resumed = deferred<AgentOutcome<string>>();
    const resume = vi
      .fn<NonNullable<ChannelAgentExecutor["resume"]>>()
      .mockReturnValue(resumed.promise);
    const service = await serveChannelAgent({
      channel,
      agent: {
        ...fakeAgent({
          generate: vi
            .fn<ChannelAgentExecutor["generate"]>()
            .mockResolvedValue(agentApproval("run-1")),
          streaming: false,
        }),
        resume,
      },
      interactions: { store },
      streaming: { placeholder: false },
    });
    const event = messageEvent();
    await channel.emit(event);

    const reply = channel.emit(messageEvent({ id: "event-2", text: "approve" }));
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    const stopping = service.stop();
    resumed.resolve(agentApproval("run-2"));
    await Promise.all([reply, stopping]);

    expect(store.get(channelInteractionKey(event))?.continuation.sourceRunId).toBe("run-2");
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

  it("does not split the growing stream while progressive edits are throttled", async () => {
    const channel = new FakeChannel();
    const finalText = "x".repeat(100);
    const stream = vi.fn<ChannelAgentExecutor["stream"]>().mockReturnValue({
      textStream: textStream(...Array.from({ length: 100 }, () => "x")),
      result: Promise.resolve(agentResponse(finalText)),
    });
    const service = await serveChannelAgent({
      channel,
      agent: fakeAgent({ stream, streaming: true }),
      streaming: { editIntervalMs: 10_000 },
    });

    await channel.emit(messageEvent());

    expect(channel.splitCount).toBe(2);
    expect(channel.edits.map((item) => item.message.text)).toEqual([finalText]);
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
