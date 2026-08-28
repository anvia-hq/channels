import type { AgentOutcome, AgentPrompt, MemoryScope } from "@anvia/core";
import type { AgentInteractionResponse } from "@anvia/core/agent/interactions";
import { sendChannelMessage } from "@anvia/channel";
import type {
  ChannelAddress,
  ChannelMessage,
  ChannelMessageEvent,
  SentChannelMessage,
} from "@anvia/channel";
import {
  channelConversationKey,
  defaultChannelAgentSession,
  defaultShouldHandleChannelEvent,
} from "./defaults.js";
import { KeyedQueue } from "./keyed-queue.js";
import {
  MemoryChannelAgentInteractionStore,
  channelInteractionKey,
  parseChannelAgentInteractionResponse,
  renderChannelAgentInteraction,
} from "./interactions.js";
import type { PendingChannelAgentInteraction } from "./interactions.js";
import { channelMessagePrompt, resolveMultimodalOptions } from "./prompts.js";
import type {
  ChannelAgentErrorContext,
  ChannelAgentInteractionOptions,
  ChannelAgentOptions,
  ChannelAgentRunInput,
} from "./types.js";

const DEFAULT_EDIT_INTERVAL_MS = 750;
const DEFAULT_PLACEHOLDER = "Thinking…";
const DEFAULT_ERROR_MESSAGE = "Sorry, I couldn't process that message.";
const DEFAULT_EMPTY_RESPONSE_MESSAGE = "I couldn't produce a response.";
const DEFAULT_INVALID_INTERACTION_RESPONSE_MESSAGE =
  "I couldn't understand that response. Please follow the requested format.";

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
  interactions:
    | false
    | Readonly<{
        store: NonNullable<ChannelAgentInteractionOptions<RawEvent>["store"]>;
        render: NonNullable<ChannelAgentInteractionOptions<RawEvent>["render"]>;
        parseResponse: NonNullable<ChannelAgentInteractionOptions<RawEvent>["parseResponse"]>;
        invalidResponseMessage: string;
      }>;
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

    let pending: PendingChannelAgentInteraction | undefined;
    if (this.options.interactions !== false) {
      try {
        pending = await this.options.interactions.store.get(channelInteractionKey(event));
      } catch (error) {
        await this.handleFailure(error, "interaction", event, undefined, signal);
        return;
      }
    }
    if (pending !== undefined) {
      await this.processInteractionResponse(event, pending, signal);
      return;
    }

    let prompt: AgentPrompt;
    let session: MemoryScope | undefined;
    try {
      [prompt, session] = await Promise.all([
        this.options.createPrompt(event, { channel: this.options.channel, abortSignal: signal }),
        this.options.createSession(event),
      ]);
    } catch (error) {
      await this.handleFailure(error, "prepare", event, undefined, signal);
      return;
    }

    const address = eventAddress(event);
    const provisional = await this.sendPlaceholder(address, event);
    if (provisional === null) return;

    let outcome: AgentOutcome<Output>;
    let deliveredText: string | undefined;
    try {
      const input: ChannelAgentRunInput = {
        prompt,
        ...(session === undefined ? {} : { session }),
        abortSignal: signal,
      };
      if (this.options.streaming.enabled) {
        const streamed = await this.streamOutcome(input, event, provisional);
        outcome = streamed.outcome;
        deliveredText = streamed.deliveredText;
      } else {
        outcome = await this.options.agent.generate(input);
      }
    } catch (error) {
      await this.handleFailure(error, "agent", event, provisional, signal);
      return;
    }
    if (signal.aborted) return;
    await this.completeOutcome(outcome, event, provisional, signal, deliveredText);
  }

  private async streamOutcome(
    input: ChannelAgentRunInput,
    event: ChannelMessageEvent<RawEvent>,
    provisional: SentChannelMessage | undefined,
  ): Promise<Readonly<{ outcome: AgentOutcome<Output>; deliveredText: string }>> {
    const stream = this.options.agent.stream(input);
    const result = stream.result;
    void result.catch(() => undefined);
    let text = "";
    let deliveredText = "";
    let lastEditAt = Date.now();

    try {
      for await (const delta of stream.textStream) {
        text += delta;
        if (provisional === undefined || text.length === 0) continue;
        const now = Date.now();
        if (now - lastEditAt < this.options.streaming.editIntervalMs) continue;
        const firstPart = this.messageParts({ text })[0];
        if (firstPart === undefined || firstPart.text === deliveredText) continue;
        try {
          await this.options.channel.edit(provisional, firstPart);
          deliveredText = firstPart.text;
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

    return { outcome: await result, deliveredText };
  }

  private async deliver(
    address: ChannelAddress,
    provisional: SentChannelMessage | undefined,
    text: string,
    deliveredText?: string,
  ): Promise<void> {
    if (text.length === 0) return;
    const parts = this.messageParts({ text });
    if (provisional === undefined) {
      await sendChannelMessage(this.options.channel, address, { text });
      return;
    }
    const first = parts[0];
    if (first === undefined)
      throw new Error("Channel splitMessage must return at least one message");
    if (first.text !== deliveredText) await this.options.channel.edit(provisional, first);
    for (const part of parts.slice(1)) {
      await this.options.channel.send(address, part);
    }
  }

  private async completeOutcome(
    outcome: AgentOutcome<Output>,
    event: ChannelMessageEvent<RawEvent>,
    provisional: SentChannelMessage | undefined,
    signal: AbortSignal,
    deliveredText?: string,
  ): Promise<void> {
    let response: string;
    try {
      if (outcome.type === "interaction" && this.options.interactions !== false) {
        if (this.options.agent.resume === undefined) {
          throw new TypeError("Channel agent executor cannot resume interactions");
        }
        const pending = {
          continuation: outcome.continuation,
          interaction: outcome.interaction,
        };
        await this.options.interactions.store.set(channelInteractionKey(event), pending);
        response = nonemptyResponse(
          await this.options.interactions.render(pending, event),
          this.options.emptyResponseMessage,
        );
      } else {
        response = nonemptyResponse(
          await this.options.renderOutcome(outcome, event),
          this.options.emptyResponseMessage,
        );
      }
    } catch (error) {
      const stage = outcome.type === "interaction" ? "interaction" : "prepare";
      await this.handleFailure(error, stage, event, provisional, signal);
      return;
    }

    if (signal.aborted) return;
    try {
      await this.deliver(eventAddress(event), provisional, response, deliveredText);
    } catch (error) {
      await this.reportError(error, { stage: "delivery", event });
    }
  }

  private async processInteractionResponse(
    event: ChannelMessageEvent<RawEvent>,
    pending: PendingChannelAgentInteraction,
    signal: AbortSignal,
  ): Promise<void> {
    const interactions = this.options.interactions;
    if (interactions === false) return;

    let response: AgentInteractionResponse | undefined;
    try {
      response = await interactions.parseResponse(event, pending);
    } catch (error) {
      await this.handleFailure(error, "interaction", event, undefined, signal);
      return;
    }
    if (response === undefined) {
      try {
        await this.deliver(eventAddress(event), undefined, interactions.invalidResponseMessage);
      } catch (error) {
        await this.reportError(error, { stage: "delivery", event });
      }
      return;
    }

    const resume = this.options.agent.resume?.bind(this.options.agent);
    if (resume === undefined) {
      await this.handleFailure(
        new TypeError("Channel agent executor cannot resume interactions"),
        "interaction",
        event,
        undefined,
        signal,
      );
      return;
    }

    const address = eventAddress(event);
    const provisional = await this.sendPlaceholder(address, event);
    if (provisional === null) return;
    const key = channelInteractionKey(event);

    let outcome: AgentOutcome<Output>;
    try {
      outcome = await resume(pending.continuation, response, { abortSignal: signal });
    } catch (error) {
      await this.handleFailure(error, "agent", event, provisional, signal);
      return;
    }

    if (outcome.type === "interaction") {
      await this.completeOutcome(outcome, event, provisional, signal);
      return;
    }
    try {
      await interactions.store.delete(key);
    } catch (error) {
      await this.handleFailure(error, "interaction", event, provisional, signal);
      return;
    }
    if (signal.aborted) return;
    await this.completeOutcome(outcome, event, provisional, signal);
  }

  private async sendPlaceholder(
    address: ChannelAddress,
    event: ChannelMessageEvent<RawEvent>,
  ): Promise<SentChannelMessage | undefined | null> {
    const placeholder = this.options.streaming.placeholder;
    if (placeholder === false) return undefined;
    try {
      const first = this.messageParts({ text: placeholder })[0];
      if (first === undefined)
        throw new Error("Channel splitMessage must return at least one message");
      return await this.options.channel.send(address, first);
    } catch (error) {
      await this.reportError(error, { stage: "delivery", event });
      return null;
    }
  }

  private messageParts(message: ChannelMessage): readonly ChannelMessage[] {
    const parts = this.options.channel.splitMessage(message);
    if (parts.length === 0)
      throw new Error("Channel splitMessage must return at least one message");
    return parts;
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
      await this.deliver(eventAddress(event), provisional, this.options.errorMessage);
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
  const interactions = resolveInteractionOptions(options.interactions);
  const multimodal =
    options.multimodal === false ? false : resolveMultimodalOptions(options.multimodal);

  return {
    channel: options.channel,
    agent: options.agent,
    shouldHandle: options.shouldHandle ?? defaultShouldHandleChannelEvent,
    createPrompt:
      options.createPrompt ??
      ((event, context) => {
        if (multimodal === false && event.attachments.length > 0) {
          throw new TypeError("Channel agent multimodal prompts are disabled");
        }
        return channelMessagePrompt(context.channel, event, {
          ...(multimodal === false ? {} : multimodal),
          signal: context.abortSignal,
        });
      }),
    createSession: options.createSession ?? defaultCreateSession(options.agent),
    renderOutcome: options.renderOutcome ?? defaultRenderOutcome,
    streaming: {
      enabled: options.streaming?.enabled ?? options.agent.model?.capabilities.streaming ?? true,
      editIntervalMs,
      placeholder,
    },
    errorMessage,
    emptyResponseMessage,
    interactions,
    onError: options.onError,
  };
}

function resolveInteractionOptions<RawEvent>(
  options: false | ChannelAgentInteractionOptions<RawEvent> | undefined,
): ResolvedOptions<RawEvent, unknown>["interactions"] {
  if (options === false) return false;
  const invalidResponseMessage =
    options?.invalidResponseMessage ?? DEFAULT_INVALID_INTERACTION_RESPONSE_MESSAGE;
  if (invalidResponseMessage.length === 0) {
    throw new TypeError("Channel agent invalid interaction response message must not be empty");
  }
  return {
    store: options?.store ?? new MemoryChannelAgentInteractionStore(),
    render: options?.render ?? renderChannelAgentInteraction,
    parseResponse: options?.parseResponse ?? parseChannelAgentInteractionResponse,
    invalidResponseMessage,
  };
}

function defaultCreateSession<Output>(
  agent: ChannelAgentOptions<unknown, Output>["agent"],
): (event: ChannelMessageEvent) => MemoryScope | undefined {
  if ("memory" in agent && agent.memory === undefined) return () => undefined;
  return defaultChannelAgentSession;
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
