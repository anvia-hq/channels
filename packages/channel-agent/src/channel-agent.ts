import { randomUUID } from "node:crypto";
import type { AgentOutcome, AgentPrompt, MemoryScope } from "@anvia/core";
import type { AgentInteractionResponse } from "@anvia/core/agent/interactions";
import { sendChannelMessage } from "@anvia/channel";
import type {
  ChannelActionEvent,
  ChannelAddress,
  ChannelEvent,
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
  channelInteractionActions,
  channelInteractionKey,
  parseChannelAgentActionResponse,
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
const DEFAULT_EXPIRED_INTERACTION_MESSAGE = "This interaction is no longer active.";
const DEFAULT_CANCEL_KEYWORD = "cancel";
const DEFAULT_CANCEL_MESSAGE = "Okay, that request was cancelled.";
const INTERRUPTED_MESSAGE = "(interrupted)";

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
        parseAction: NonNullable<ChannelAgentInteractionOptions<RawEvent>["parseAction"]>;
        invalidResponseMessage: string;
        expiredInteractionMessage: string;
        timeoutMs: number | undefined;
        cancelKeyword: string | false;
        cancelMessage: string | false;
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

  private async accept(event: ChannelEvent<RawEvent>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;

    if (event.type === "action") {
      if (event.sender.bot) return;
      await this.queue.run(channelConversationKey(event), () => this.processAction(event, signal));
      return;
    }
    if (event.type !== "message") return;

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

  private async processAction(
    event: ChannelActionEvent<RawEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    const interactions = this.options.interactions;
    if (interactions === false || signal.aborted) return;
    let pending: PendingChannelAgentInteraction | undefined;
    try {
      pending = await interactions.store.get(channelInteractionKey(event));
    } catch (error) {
      await this.handleFailure(error, "interaction", event, undefined, signal);
      return;
    }
    if (pending === undefined) {
      await this.deliverInteractionNotice(event, interactions.expiredInteractionMessage);
      return;
    }
    let response: AgentInteractionResponse | undefined;
    try {
      response = await interactions.parseAction(event, pending);
    } catch (error) {
      await this.handleFailure(error, "interaction", event, undefined, signal);
      return;
    }
    if (response === undefined) {
      await this.deliverInteractionNotice(event, interactions.expiredInteractionMessage);
      return;
    }
    await this.resumeInteraction(event, pending, response, signal);
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
      const input: {
        prompt: AgentPrompt;
        session?: MemoryScope;
        abortSignal: AbortSignal;
      } = {
        prompt,
        abortSignal: signal,
      };
      if (session !== undefined) input.session = session;
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
    if (signal.aborted) {
      await this.cleanupPlaceholder(provisional);
      return;
    }
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
    const edit = this.options.channel.edit;

    try {
      for await (const delta of stream.textStream) {
        text += delta;
        if (provisional === undefined || edit === undefined || text.length === 0) continue;
        const now = Date.now();
        if (now - lastEditAt < this.options.streaming.editIntervalMs) continue;
        const firstPart = this.messageParts({ text })[0];
        if (firstPart === undefined || firstPart.text === deliveredText) continue;
        try {
          await edit.call(this.options.channel, provisional, firstPart);
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
    response: string | ChannelMessage,
    deliveredText?: string,
  ): Promise<void> {
    const message = typeof response === "string" ? { text: response } : response;
    const text = message.text;
    if (text.length === 0 && message.attachments === undefined) return;
    const parts = this.messageParts(message);
    if (provisional === undefined) {
      await sendChannelMessage(this.options.channel, address, message);
      return;
    }
    if (message.attachments !== undefined) {
      const deleteMessage = this.options.channel.delete;
      if (deleteMessage === undefined) {
        throw new Error("Attachment delivery with a placeholder requires channel deletion support");
      }
      await sendChannelMessage(this.options.channel, address, message);
      await deleteMessage.call(this.options.channel, provisional);
      return;
    }
    const first = parts[0];
    if (first === undefined)
      throw new Error("Channel splitMessage must return at least one message");
    const edit = this.options.channel.edit;
    if (first.text !== deliveredText && edit !== undefined) {
      await edit.call(this.options.channel, provisional, first);
    }
    for (const part of parts.slice(1)) {
      await this.options.channel.send(address, part);
    }
  }

  private async completeOutcome(
    outcome: AgentOutcome<Output>,
    event: ChannelMessageEvent<RawEvent> | ChannelActionEvent<RawEvent>,
    provisional: SentChannelMessage | undefined,
    signal: AbortSignal,
    deliveredText?: string,
  ): Promise<void> {
    let response: ChannelMessage;
    let pending: PendingChannelAgentInteraction | undefined;
    try {
      if (outcome.type === "interaction" && this.options.interactions !== false) {
        if (this.options.agent.resume === undefined) {
          throw new TypeError("Channel agent executor cannot resume interactions");
        }
        pending = {
          continuation: outcome.continuation,
          interaction: outcome.interaction,
        };
        if (this.options.channel.capabilities?.actions === true) {
          pending = { ...pending, actionToken: randomUUID().replaceAll("-", "") };
        }
        const timeoutMs = this.options.interactions.timeoutMs;
        if (timeoutMs !== undefined) {
          pending = { ...pending, expiresAt: Date.now() + timeoutMs };
        }
        await this.options.interactions.store.set(channelInteractionKey(event), pending);
        const rendered = responseMessage(
          await this.options.interactions.render(pending, event),
          this.options.emptyResponseMessage,
        );
        const actions = channelInteractionActions(pending);
        response =
          actions === undefined || rendered.actions !== undefined
            ? rendered
            : { ...rendered, actions };
      } else {
        response = responseMessage(
          await this.options.renderOutcome(outcome, event),
          this.options.emptyResponseMessage,
        );
      }
    } catch (error) {
      if (pending !== undefined) await this.rollbackInteraction(event, pending);
      const stage = outcome.type === "interaction" ? "interaction" : "prepare";
      await this.handleFailure(error, stage, event, provisional, signal);
      return;
    }

    if (signal.aborted) {
      await this.cleanupPlaceholder(provisional);
      return;
    }
    try {
      await this.deliver(eventAddress(event), provisional, response, deliveredText);
    } catch (error) {
      if (pending !== undefined) await this.rollbackInteraction(event, pending);
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
    const cancelKeyword = interactions.cancelKeyword;
    if (
      cancelKeyword !== false &&
      event.text.trim().toLowerCase() === cancelKeyword.trim().toLowerCase()
    ) {
      const claimed = await interactions.store.take(
        channelInteractionKey(event),
        pending.interaction.id,
      );
      if (claimed === undefined) {
        await this.deliverInteractionNotice(event, interactions.expiredInteractionMessage);
        return;
      }
      if (interactions.cancelMessage !== false) {
        await this.deliverInteractionNotice(event, interactions.cancelMessage);
      }
      return;
    }

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

    await this.resumeInteraction(event, pending, response, signal);
  }

  private async resumeInteraction(
    event: ChannelMessageEvent<RawEvent> | ChannelActionEvent<RawEvent>,
    pending: PendingChannelAgentInteraction,
    response: AgentInteractionResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const interactions = this.options.interactions;
    if (interactions === false) return;
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

    const key = channelInteractionKey(event);
    let claimed: PendingChannelAgentInteraction | undefined;
    try {
      claimed = await interactions.store.take(key, pending.interaction.id);
    } catch (error) {
      await this.handleFailure(error, "interaction", event, undefined, signal);
      return;
    }
    if (claimed === undefined) {
      await this.deliverInteractionNotice(event, interactions.expiredInteractionMessage);
      return;
    }

    const address = eventAddress(event);
    const provisional = await this.sendPlaceholder(address, event);
    if (provisional === null) {
      await this.restoreInteraction(key, claimed, event);
      return;
    }

    let outcome: AgentOutcome<Output>;
    try {
      outcome = await resume(claimed.continuation, response, { abortSignal: signal });
    } catch (error) {
      await this.restoreInteraction(key, claimed, event);
      await this.handleFailure(error, "agent", event, provisional, signal);
      return;
    }
    if (signal.aborted && outcome.type !== "interaction") {
      await this.cleanupPlaceholder(provisional);
      return;
    }
    await this.completeOutcome(outcome, event, provisional, signal);
  }

  private async restoreInteraction(
    key: string,
    pending: PendingChannelAgentInteraction,
    event: ChannelEvent<RawEvent>,
  ): Promise<void> {
    const interactions = this.options.interactions;
    if (interactions === false) return;
    try {
      await interactions.store.set(key, pending);
    } catch (error) {
      await this.reportError(error, { stage: "interaction", event });
    }
  }

  private async rollbackInteraction(
    event: ChannelMessageEvent<RawEvent> | ChannelActionEvent<RawEvent>,
    pending: PendingChannelAgentInteraction,
  ): Promise<void> {
    const interactions = this.options.interactions;
    if (interactions === false) return;
    try {
      await interactions.store.delete(channelInteractionKey(event), pending.interaction.id);
    } catch (error) {
      await this.reportError(error, { stage: "interaction", event });
    }
  }

  private async cleanupPlaceholder(provisional: SentChannelMessage | undefined): Promise<void> {
    if (provisional === undefined) return;
    const channel = this.options.channel;
    const deleteMessage = channel.delete;
    if (deleteMessage !== undefined) {
      try {
        await deleteMessage.call(channel, provisional);
        return;
      } catch {
        // Fall through to the edit fallback.
      }
    }
    if (channel.capabilities?.messageEdits !== true) return;
    const edit = channel.edit;
    if (edit === undefined) return;
    try {
      await edit.call(channel, provisional, { text: INTERRUPTED_MESSAGE });
    } catch {
      // Best-effort shutdown cleanup; nothing further to do.
    }
  }

  private async deliverInteractionNotice(
    event: ChannelEvent<RawEvent>,
    message: string,
  ): Promise<void> {
    try {
      await this.deliver(eventAddress(event), undefined, message);
    } catch (error) {
      await this.reportError(error, { stage: "delivery", event });
    }
  }

  private async sendPlaceholder(
    address: ChannelAddress,
    event: ChannelEvent<RawEvent>,
  ): Promise<SentChannelMessage | undefined | null> {
    if (this.options.channel.capabilities?.typing === true) {
      try {
        await this.options.channel.showTyping?.(address);
      } catch (error) {
        await this.reportError(error, { stage: "delivery", event });
      }
    }
    const placeholder = this.options.streaming.placeholder;
    if (placeholder === false || this.options.channel.edit === undefined) return undefined;
    if (
      this.options.channel.capabilities?.outboundAttachments !== undefined &&
      this.options.channel.delete === undefined
    ) {
      return undefined;
    }
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
    event: ChannelEvent<RawEvent>,
    provisional: SentChannelMessage | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      await this.cleanupPlaceholder(provisional);
      return;
    }
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
        if (multimodal === false) {
          return channelMessagePrompt(context.channel, event, { signal: context.abortSignal });
        }
        return channelMessagePrompt(context.channel, event, {
          ...multimodal,
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
  const expiredInteractionMessage =
    options?.expiredInteractionMessage ?? DEFAULT_EXPIRED_INTERACTION_MESSAGE;
  if (expiredInteractionMessage.length === 0) {
    throw new TypeError("Channel agent expired interaction message must not be empty");
  }
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError("Channel agent interaction timeout must be a positive integer");
  }
  const cancelKeyword =
    options?.cancelKeyword === undefined ? DEFAULT_CANCEL_KEYWORD : options.cancelKeyword;
  if (cancelKeyword !== false && cancelKeyword.trim().length === 0) {
    throw new TypeError("Channel agent cancel keyword must not be blank");
  }
  const cancelMessage =
    options?.cancelMessage === undefined ? DEFAULT_CANCEL_MESSAGE : options.cancelMessage;
  if (cancelMessage !== false && cancelMessage.length === 0) {
    throw new TypeError("Channel agent cancel message must not be empty");
  }
  return {
    store: options?.store ?? new MemoryChannelAgentInteractionStore(),
    render: options?.render ?? renderChannelAgentInteraction,
    parseResponse: options?.parseResponse ?? parseChannelAgentInteractionResponse,
    parseAction: options?.parseAction ?? parseChannelAgentActionResponse,
    invalidResponseMessage,
    expiredInteractionMessage,
    timeoutMs,
    cancelKeyword,
    cancelMessage,
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

function responseMessage(value: string | ChannelMessage, fallback: string): ChannelMessage {
  const message = typeof value === "string" ? { text: value } : value;
  return message.text.length === 0 && message.attachments === undefined
    ? { text: fallback }
    : message;
}

function eventAddress(event: ChannelEvent): ChannelAddress {
  const address: {
    platform: string;
    accountId?: string;
    conversationId: string;
    threadId?: string;
  } = {
    platform: event.platform,
    conversationId: event.conversation.id,
  };
  if (event.accountId !== undefined) address.accountId = event.accountId;
  if (event.conversation.threadId !== undefined) {
    address.threadId = event.conversation.threadId;
  }
  return address;
}
