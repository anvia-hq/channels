import type { AgentOutcome, AgentPrompt, MemoryScope } from "@anvia/core";
import type { ChannelAddress, ChannelMessageEvent, SentChannelMessage } from "@anvia/channel";
import {
  channelConversationKey,
  defaultChannelAgentSession,
  defaultShouldHandleChannelEvent,
} from "./defaults.js";
import { KeyedQueue } from "./keyed-queue.js";
import type {
  ChannelAgentErrorContext,
  ChannelAgentOptions,
  ChannelAgentRunInput,
} from "./types.js";

const DEFAULT_EDIT_INTERVAL_MS = 750;
const DEFAULT_PLACEHOLDER = "Thinking…";
const DEFAULT_ERROR_MESSAGE = "Sorry, I couldn't process that message.";
const DEFAULT_EMPTY_RESPONSE_MESSAGE = "I couldn't produce a response.";

type ResolvedOptions<RawEvent, Output> = Readonly<{
  channel: ChannelAgentOptions<RawEvent, Output>["channel"];
  agent: ChannelAgentOptions<RawEvent, Output>["agent"];
  shouldHandle: NonNullable<ChannelAgentOptions<RawEvent, Output>["shouldHandle"]>;
  createPrompt: NonNullable<ChannelAgentOptions<RawEvent, Output>["createPrompt"]>;
  createSession: NonNullable<ChannelAgentOptions<RawEvent, Output>["createSession"]>;
  renderOutcome: NonNullable<ChannelAgentOptions<RawEvent, Output>["renderOutcome"]>;
  streaming: Readonly<{
    enabled: boolean;
    editIntervalMs: number;
    placeholder: string | false;
  }>;
  errorMessage: string | false;
  emptyResponseMessage: string;
  onError: ChannelAgentOptions<RawEvent, Output>["onError"];
}>;

export function createChannelAgent<RawEvent = unknown, Output = string>(
  options: ChannelAgentOptions<RawEvent, Output>,
): ChannelAgentService<RawEvent, Output> {
  return new ChannelAgentService(options);
}

export async function serveChannelAgent<RawEvent = unknown, Output = string>(
  options: ChannelAgentOptions<RawEvent, Output>,
): Promise<ChannelAgentService<RawEvent, Output>> {
  const service = createChannelAgent(options);
  await service.start();
  return service;
}

export class ChannelAgentService<RawEvent = unknown, Output = string> {
  private readonly options: ResolvedOptions<RawEvent, Output>;
  private readonly queue = new KeyedQueue();
  private controller: AbortController | undefined;

  constructor(options: ChannelAgentOptions<RawEvent, Output>) {
    this.options = resolveOptions(options);
  }

  async start(): Promise<void> {
    if (this.controller !== undefined) throw new Error("Channel agent is already running");
    const controller = new AbortController();
    this.controller = controller;
    try {
      await this.options.channel.start((event) => this.accept(event, controller.signal));
    } catch (error) {
      if (this.controller === controller) this.controller = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    if (controller === undefined) return;
    controller.abort();
    try {
      await this.options.channel.stop();
    } finally {
      await this.queue.drain();
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private async accept(event: ChannelMessageEvent<RawEvent>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;

    let shouldHandle: boolean;
    try {
      shouldHandle = await this.options.shouldHandle(event);
    } catch (error) {
      await this.reportError(error, { stage: "filter", event });
      return;
    }
    if (!shouldHandle || signal.aborted) return;

    await this.queue.run(channelConversationKey(event), () => this.process(event, signal));
  }

  private async process(event: ChannelMessageEvent<RawEvent>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;

    let prompt: AgentPrompt;
    let session: MemoryScope;
    try {
      [prompt, session] = await Promise.all([
        this.options.createPrompt(event),
        this.options.createSession(event),
      ]);
    } catch (error) {
      await this.handleFailure(error, "prepare", event, undefined, signal);
      return;
    }

    const address = eventAddress(event);
    let provisional: SentChannelMessage | undefined;
    if (this.options.streaming.placeholder !== false) {
      try {
        provisional = await this.options.channel.send(address, {
          text: this.options.streaming.placeholder,
        });
      } catch (error) {
        await this.reportError(error, { stage: "delivery", event });
        return;
      }
    }

    let response: string;
    try {
      const input: ChannelAgentRunInput = { prompt, session, abortSignal: signal };
      response = this.options.streaming.enabled
        ? await this.streamResponse(input, event, provisional)
        : await this.generateResponse(input, event);
    } catch (error) {
      await this.handleFailure(error, "agent", event, provisional, signal);
      return;
    }
    if (signal.aborted) return;

    try {
      await this.deliver(address, provisional, response);
    } catch (error) {
      await this.reportError(error, { stage: "delivery", event });
    }
  }

  private async streamResponse(
    input: ChannelAgentRunInput,
    event: ChannelMessageEvent<RawEvent>,
    provisional: SentChannelMessage | undefined,
  ): Promise<string> {
    const stream = this.options.agent.stream(input);
    const result = stream.result;
    void result.catch(() => undefined);
    let text = "";
    let deliveredText = "";
    let lastEditAt = Date.now();

    try {
      for await (const delta of stream.textStream) {
        text += delta;
        if (provisional === undefined || text === deliveredText) continue;
        const now = Date.now();
        if (now - lastEditAt < this.options.streaming.editIntervalMs) continue;
        try {
          await this.options.channel.edit(provisional, { text });
          deliveredText = text;
          lastEditAt = now;
        } catch (error) {
          await this.reportError(error, { stage: "delivery", event });
          lastEditAt = now;
        }
      }
    } catch (error) {
      void result.catch(() => undefined);
      throw error;
    }

    const outcome = await result;
    const rendered = nonemptyResponse(
      await this.options.renderOutcome(outcome, event),
      this.options.emptyResponseMessage,
    );
    return rendered === deliveredText ? "" : rendered;
  }

  private async generateResponse(
    input: ChannelAgentRunInput,
    event: ChannelMessageEvent<RawEvent>,
  ): Promise<string> {
    const outcome = await this.options.agent.generate(input);
    return nonemptyResponse(
      await this.options.renderOutcome(outcome, event),
      this.options.emptyResponseMessage,
    );
  }

  private async deliver(
    address: ChannelAddress,
    provisional: SentChannelMessage | undefined,
    text: string,
  ): Promise<void> {
    if (text.length === 0) return;
    if (provisional === undefined) {
      await this.options.channel.send(address, { text });
      return;
    }
    await this.options.channel.edit(provisional, { text });
  }

  private async handleFailure(
    error: unknown,
    stage: ChannelAgentErrorContext<RawEvent>["stage"],
    event: ChannelMessageEvent<RawEvent>,
    provisional: SentChannelMessage | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    await this.reportError(error, { stage, event });
    if (this.options.errorMessage === false) return;

    try {
      if (provisional === undefined) {
        await this.options.channel.send(eventAddress(event), { text: this.options.errorMessage });
      } else {
        await this.options.channel.edit(provisional, { text: this.options.errorMessage });
      }
    } catch (deliveryError) {
      await this.reportError(deliveryError, { stage: "delivery", event });
    }
  }

  private async reportError(
    error: unknown,
    context: ChannelAgentErrorContext<RawEvent>,
  ): Promise<void> {
    try {
      await this.options.onError?.(error, context);
    } catch {
      // Error observers must not interrupt channel delivery.
    }
  }
}

function resolveOptions<RawEvent, Output>(
  options: ChannelAgentOptions<RawEvent, Output>,
): ResolvedOptions<RawEvent, Output> {
  const editIntervalMs = options.streaming?.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
  if (!Number.isSafeInteger(editIntervalMs) || editIntervalMs < 0) {
    throw new TypeError("Channel agent edit interval must be a nonnegative integer");
  }

  const placeholder = options.streaming?.placeholder ?? DEFAULT_PLACEHOLDER;
  if (placeholder !== false && placeholder.length === 0) {
    throw new TypeError("Channel agent placeholder must not be empty");
  }
  const errorMessage = options.errorMessage ?? DEFAULT_ERROR_MESSAGE;
  if (errorMessage !== false && errorMessage.length === 0) {
    throw new TypeError("Channel agent error message must not be empty");
  }
  const emptyResponseMessage = options.emptyResponseMessage ?? DEFAULT_EMPTY_RESPONSE_MESSAGE;
  if (emptyResponseMessage.length === 0) {
    throw new TypeError("Channel agent empty response message must not be empty");
  }

  return {
    channel: options.channel,
    agent: options.agent,
    shouldHandle: options.shouldHandle ?? defaultShouldHandleChannelEvent,
    createPrompt: options.createPrompt ?? ((event) => event.text),
    createSession: options.createSession ?? defaultChannelAgentSession,
    renderOutcome: options.renderOutcome ?? defaultRenderOutcome,
    streaming: {
      enabled: options.streaming?.enabled ?? options.agent.model?.capabilities.streaming ?? true,
      editIntervalMs,
      placeholder,
    },
    errorMessage,
    emptyResponseMessage,
    onError: options.onError,
  };
}

function defaultRenderOutcome<Output>(outcome: AgentOutcome<Output>): string {
  if (outcome.text.length > 0) return outcome.text;
  if (outcome.type === "blocked") return outcome.message ?? outcome.reason;
  if (outcome.type === "interaction") {
    return "The agent needs additional input that this channel cannot handle yet.";
  }
  return "";
}

function nonemptyResponse(text: string, fallback: string): string {
  return text.length === 0 ? fallback : text;
}

function eventAddress(event: ChannelMessageEvent): ChannelAddress {
  return {
    platform: event.platform,
    ...(event.accountId === undefined ? {} : { accountId: event.accountId }),
    conversationId: event.conversation.id,
    ...(event.conversation.threadId === undefined ? {} : { threadId: event.conversation.threadId }),
  };
}
