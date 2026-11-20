import { randomUUID } from "node:crypto";
import type { AgentOutcome, AgentPrompt, MemoryScope } from "@anvia/core";
import type { AgentInteractionResponse } from "@anvia/core/agent/interactions";
import { reportChannelError } from "@anvia/channel/adapter";
import type {
  ChannelActionEvent,
  ChannelAddress,
  ChannelCommandEvent,
  ChannelEvent,
  ChannelMessage,
  ChannelMessageEvent,
  SentChannelMessage,
} from "@anvia/channel";
import { channelConversationKey } from "./defaults.js";
import {
  cleanupPlaceholder,
  deliverChannelResponse,
  reactToEvent,
  sendPlaceholder,
  unreactFromEvent,
} from "./delivery.js";
import { runWithTimeout, streamAgentOutcome } from "./execution.js";
import { channelInteractionActions, channelInteractionKey } from "./interactions.js";
import type { PendingChannelAgentInteraction } from "./interactions.js";
import { KeyedQueue } from "./keyed-queue.js";
import { commandAsMessage, eventAddress, resolveOptions, responseMessage } from "./options.js";
import type { CommandOverrides, ResolvedChannelAgentOptions } from "./options.js";
import type {
  ChannelAgentCommandHandler,
  ChannelAgentErrorContext,
  ChannelAgentOptions,
} from "./types.js";

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
  private readonly options: ResolvedChannelAgentOptions<RawEvent, Output>;
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
      await this.queue.drain();
      await this.options.channel.stop();
    } finally {
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

    if (event.type === "command") {
      await this.acceptCommand(event, signal);
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

  private async acceptCommand(
    event: ChannelCommandEvent<RawEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    if (event.sender.bot) return;

    const commands = this.options.commands;

    if (commands === false) return;

    const handler = commands.commands[event.name];
    let shouldHandle: boolean;
    try {
      shouldHandle = await commands.shouldHandle(event);

      if (shouldHandle && handler?.shouldHandle !== undefined) {
        shouldHandle = await handler.shouldHandle(event);
      }
    } catch (error) {
      await this.reportError(error, { stage: "filter", event });
      return;
    }

    if (!shouldHandle || signal.aborted) return;

    const overrides = commandOverrides(handler, event);
    await this.queue.run(channelConversationKey(event), () =>
      this.process(commandAsMessage(event), signal, overrides),
    );
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
      response = await interactions.parseAction({ event, pending });
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

  private async process(
    event: ChannelMessageEvent<RawEvent>,
    signal: AbortSignal,
    overrides?: CommandOverrides<RawEvent, Output>,
  ): Promise<void> {
    if (signal.aborted) return;

    await this.acknowledgeEvent(event, signal);

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
        (overrides?.createPrompt ?? this.options.createPrompt)({
          event,
          context: { channel: this.options.channel, abortSignal: signal },
        }),
        (overrides?.createSession ?? this.options.createSession)(event),
      ]);
    } catch (error) {
      await this.handleFailure(error, "prepare", event, undefined, signal);
      return;
    }

    const address = eventAddress(event);
    const provisional = await this.createPlaceholder(address, event);

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
        const streamed = await runWithTimeout(signal, this.options.runTimeoutMs, (runSignal) =>
          streamAgentOutcome({
            agent: this.options.agent,
            channel: this.options.channel,
            input: { ...input, abortSignal: runSignal },
            event,
            provisional,
            editIntervalMs: this.options.streaming.editIntervalMs,
            onDeliveryError: (error) => this.reportError(error, { stage: "delivery", event }),
          }),
        );
        outcome = streamed.outcome;
        deliveredText = streamed.deliveredText;
      } else {
        outcome = await runWithTimeout(signal, this.options.runTimeoutMs, (runSignal) =>
          this.options.agent.generate({ ...input, abortSignal: runSignal }),
        );
      }
    } catch (error) {
      await this.handleFailure(error, "agent", event, provisional, signal);
      return;
    }

    if (signal.aborted) {
      await cleanupPlaceholder(this.options.channel, provisional);
      return;
    }

    await this.completeOutcome(outcome, event, provisional, signal, deliveredText, overrides);
  }

  private async completeOutcome(
    outcome: AgentOutcome<Output>,
    event: ChannelMessageEvent<RawEvent> | ChannelActionEvent<RawEvent>,
    provisional: SentChannelMessage | undefined,
    signal: AbortSignal,
    deliveredText?: string,
    overrides?: CommandOverrides<RawEvent, Output>,
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
          await this.options.interactions.render({ pending, event }),
          this.options.emptyResponseMessage,
        );
        const actions = channelInteractionActions(pending);
        response =
          actions === undefined || rendered.actions !== undefined
            ? rendered
            : { ...rendered, actions };
      } else {
        response = responseMessage(
          await (overrides?.renderOutcome ?? this.options.renderOutcome)({ outcome, event }),
          this.options.emptyResponseMessage,
        );
      }
    } catch (error) {
      if (pending !== undefined) await this.rollbackInteraction(event, pending);

      const stage = outcome.type === "interaction" ? "interaction" : "prepare";
      await this.handleFailure(error, stage, event, provisional, signal);
      return;
    }

    try {
      await this.deliver(eventAddress(event), event, provisional, response, deliveredText);
    } catch (error) {
      if (pending !== undefined) await this.rollbackInteraction(event, pending);

      await this.reportError(error, { stage: "delivery", event });
      return;
    }

    const acknowledge = this.options.acknowledge;

    if (
      outcome.type !== "interaction" &&
      acknowledge !== false &&
      acknowledge.completeReaction !== undefined &&
      event.type === "message"
    ) {
      if (acknowledge.clearOnCompletion !== false) {
        await unreactFromEvent({
          channel: this.options.channel,
          event,
          reaction: acknowledge.reaction,
          signal,
          reportError: (error, context) => this.reportError(error, context),
        });
      }

      await reactToEvent({
        channel: this.options.channel,
        event,
        reaction: acknowledge.completeReaction,
        signal,
        reportError: (error, context) => this.reportError(error, context),
      });
    }
  }

  private async acknowledgeEvent(
    event: ChannelMessageEvent<RawEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    const acknowledge = this.options.acknowledge;

    if (acknowledge === false || signal.aborted) return;

    await reactToEvent({
      channel: this.options.channel,
      event,
      reaction: acknowledge.reaction,
      signal,
      reportError: (error, context) => this.reportError(error, context),
    });
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
      let claimed: PendingChannelAgentInteraction | undefined;
      try {
        claimed = await interactions.store.take({
          key: channelInteractionKey(event),
          interactionId: pending.interaction.id,
        });
      } catch (error) {
        await this.handleFailure(error, "interaction", event, undefined, signal);
        return;
      }

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
      response = await interactions.parseResponse({ event, pending });
    } catch (error) {
      await this.handleFailure(error, "interaction", event, undefined, signal);
      return;
    }

    if (response === undefined) {
      await this.deliverInteractionNotice(event, interactions.invalidResponseMessage);
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
      claimed = await interactions.store.take({ key, interactionId: pending.interaction.id });
    } catch (error) {
      await this.handleFailure(error, "interaction", event, undefined, signal);
      return;
    }

    if (claimed === undefined) {
      await this.deliverInteractionNotice(event, interactions.expiredInteractionMessage);
      return;
    }

    const address = eventAddress(event);
    const provisional = await this.createPlaceholder(address, event);

    if (provisional === null) {
      await this.restoreInteraction(key, claimed, event);
      return;
    }

    let outcome: AgentOutcome<Output>;
    try {
      outcome = await runWithTimeout(signal, this.options.runTimeoutMs, (runSignal) =>
        resume(claimed.continuation, response, { abortSignal: runSignal }),
      );
    } catch (error) {
      await this.restoreInteraction(key, claimed, event);
      await this.handleFailure(error, "agent", event, provisional, signal);
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
      await interactions.store.delete({
        key: channelInteractionKey(event),
        interactionId: pending.interaction.id,
      });
    } catch (error) {
      await this.reportError(error, { stage: "interaction", event });
    }
  }

  private async deliverInteractionNotice(
    event: ChannelEvent<RawEvent>,
    message: string,
  ): Promise<void> {
    try {
      await this.deliver(eventAddress(event), event, undefined, message);
    } catch (error) {
      await this.reportError(error, { stage: "delivery", event });
    }
  }

  private createPlaceholder(
    address: ChannelAddress,
    event: ChannelEvent<RawEvent>,
  ): Promise<SentChannelMessage | undefined | null> {
    return sendPlaceholder({
      channel: this.options.channel,
      address,
      event,
      placeholder: this.options.streaming.placeholder,
      reportError: (error, context) => this.reportError(error, context),
    });
  }

  private deliver(
    address: ChannelAddress,
    event: ChannelEvent<RawEvent>,
    provisional: SentChannelMessage | undefined,
    response: string | ChannelMessage,
    deliveredText?: string,
  ): Promise<void> {
    if (deliveredText === undefined) {
      return deliverChannelResponse({
        channel: this.options.channel,
        address,
        event,
        provisional,
        response,
        reportError: (error, context) => this.reportError(error, context),
      });
    }

    return deliverChannelResponse({
      channel: this.options.channel,
      address,
      event,
      provisional,
      response,
      deliveredText,
      reportError: (error, context) => this.reportError(error, context),
    });
  }

  private async handleFailure(
    error: unknown,
    stage: ChannelAgentErrorContext<RawEvent>["stage"],
    event: ChannelEvent<RawEvent>,
    provisional: SentChannelMessage | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      await cleanupPlaceholder(this.options.channel, provisional);
      return;
    }

    await this.reportError(error, { stage, event });

    if (this.options.errorMessage === false) return;

    try {
      await this.deliver(eventAddress(event), event, provisional, this.options.errorMessage);
    } catch (deliveryError) {
      await this.reportError(deliveryError, { stage: "delivery", event });
    }
  }

  private reportError(error: unknown, context: ChannelAgentErrorContext<RawEvent>): Promise<void> {
    return reportChannelError(this.options.onError, error, context);
  }
}

function commandOverrides<RawEvent, Output>(
  handler: ChannelAgentCommandHandler<RawEvent, Output> | undefined,
  commandEvent: ChannelCommandEvent<RawEvent>,
): CommandOverrides<RawEvent, Output> | undefined {
  if (handler === undefined) return undefined;

  const overrides: CommandOverrides<RawEvent, Output> = {};

  if (handler.createPrompt !== undefined) {
    const createPrompt = handler.createPrompt;
    overrides.createPrompt = (request) => createPrompt({ ...request, event: commandEvent });
  }

  if (handler.createSession !== undefined) {
    const createSession = handler.createSession;
    overrides.createSession = () => createSession(commandEvent);
  }

  if (handler.renderOutcome !== undefined) {
    const renderOutcome = handler.renderOutcome;
    overrides.renderOutcome = (request) => renderOutcome({ ...request, event: commandEvent });
  }

  return overrides;
}
