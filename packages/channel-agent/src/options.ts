import type { AgentOutcome, AgentPrompt, MemoryScope } from "@anvia/core";
import type {
  ChannelAddress,
  ChannelCommandEvent,
  ChannelEvent,
  ChannelMessage,
  ChannelMessageEvent,
} from "@anvia/channel";
import { defaultChannelAgentSession, defaultShouldHandleChannelEvent } from "./defaults.js";
import {
  MemoryChannelAgentInteractionStore,
  parseChannelAgentActionResponse,
  parseChannelAgentInteractionResponse,
  renderChannelAgentInteraction,
} from "./interactions.js";
import { channelMessagePrompt, resolveMultimodalOptions } from "./prompts.js";
import type {
  ChannelAgentAcknowledgementOptions,
  ChannelAgentCommandHandler,
  ChannelAgentCommandOptions,
  ChannelAgentInteractionOptions,
  ChannelAgentOptions,
  ChannelAgentPromptContext,
} from "./types.js";

const DEFAULT_EDIT_INTERVAL_MS = 750;
const DEFAULT_RUN_TIMEOUT_MS = 5 * 60 * 1_000;

const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_PLACEHOLDER = "Thinking…";
const DEFAULT_ERROR_MESSAGE = "Sorry, I couldn't process that message.";
const DEFAULT_EMPTY_RESPONSE_MESSAGE = "I couldn't produce a response.";
const DEFAULT_INVALID_INTERACTION_RESPONSE_MESSAGE =
  "I couldn't understand that response. Please follow the requested format.";
const DEFAULT_EXPIRED_INTERACTION_MESSAGE = "This interaction is no longer active.";
const DEFAULT_CANCEL_KEYWORD = "cancel";
const DEFAULT_CANCEL_MESSAGE = "Okay, that request was cancelled.";

export const INTERRUPTED_MESSAGE = "(interrupted)";
export const RUN_TIMEOUT_MESSAGE = "Channel agent run timed out";

export function timedOutError(): Error {
  return new Error(RUN_TIMEOUT_MESSAGE);
}

export type ResolvedChannelAgentOptions<RawEvent, Output> = Readonly<{
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

  runTimeoutMs: number;
  errorMessage: string | false;
  emptyResponseMessage: string;
  acknowledge: ChannelAgentAcknowledgementOptions | false;
  commands:
    | false
    | Readonly<{
        shouldHandle: NonNullable<ChannelAgentCommandOptions<RawEvent>["shouldHandle"]>;
        commands: Readonly<
          Record<string, ChannelAgentCommandHandler<RawEvent, Output> | undefined>
        >;
      }>;
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

export type CommandOverrides<RawEvent, Output> = {
  createPrompt?: (
    request: Readonly<{
      event: ChannelMessageEvent<RawEvent>;
      context: ChannelAgentPromptContext<RawEvent>;
    }>,
  ) => AgentPrompt | Promise<AgentPrompt>;
  createSession?: NonNullable<ChannelAgentOptions<RawEvent, Output>["createSession"]>;
  renderOutcome?: NonNullable<ChannelAgentOptions<RawEvent, Output>["renderOutcome"]>;
};

export function resolveOptions<RawEvent, Output>(
  options: ChannelAgentOptions<RawEvent, Output>,
): ResolvedChannelAgentOptions<RawEvent, Output> {
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

  const runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  if (
    runTimeoutMs !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(runTimeoutMs) || runTimeoutMs <= 0 || runTimeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new TypeError(
      "Channel agent run timeout must be a positive integer no larger than 2147483647",
    );
  }

  const interactions = resolveInteractionOptions(options.interactions);
  const multimodal =
    options.multimodal === false ? false : resolveMultimodalOptions(options.multimodal);
  const acknowledge = resolveAcknowledgement(options.acknowledge);
  const commands =
    options.commands === false || options.commands === undefined
      ? false
      : {
          shouldHandle:
            (options.commands === true ? undefined : options.commands.shouldHandle) ?? (() => true),
          commands: options.commands === true ? {} : (options.commands.commands ?? {}),
        };

  return {
    channel: options.channel,
    agent: options.agent,
    shouldHandle: options.shouldHandle ?? defaultShouldHandleChannelEvent,
    createPrompt:
      options.createPrompt ??
      ((request) => {
        const { event, context } = request;

        if (multimodal === false && event.attachments.length > 0) {
          throw new TypeError("Channel agent multimodal prompts are disabled");
        }

        if (multimodal === false) {
          return channelMessagePrompt({
            channel: context.channel,
            event,
            signal: context.abortSignal,
          });
        }

        return channelMessagePrompt({
          channel: context.channel,
          event,
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
    runTimeoutMs,
    errorMessage,
    emptyResponseMessage,
    acknowledge,
    commands,
    interactions,
    onError: options.onError,
  };
}

export function commandAsMessage<RawEvent>(
  event: ChannelCommandEvent<RawEvent>,
): ChannelMessageEvent<RawEvent> {
  const text = event.text.length > 0 ? `/${event.name} ${event.text}` : `/${event.name}`;
  const message: {
    type: "message";
    id: string;
    platform: string;
    accountId?: string;
    conversation: ChannelCommandEvent<RawEvent>["conversation"];
    sender: ChannelCommandEvent<RawEvent>["sender"];
    text: string;
    attachments: readonly [];
    mentionedBot: boolean;
    raw: RawEvent;
  } = {
    type: "message",
    id: event.id,
    platform: event.platform,
    conversation: event.conversation,
    sender: event.sender,
    text,
    attachments: [],
    mentionedBot: true,
    raw: event.raw,
  };

  if (event.accountId !== undefined) message.accountId = event.accountId;

  return message;
}

export function responseMessage(value: string | ChannelMessage, fallback: string): ChannelMessage {
  const message = typeof value === "string" ? { text: value } : value;
  return message.text.length === 0 && message.attachments === undefined
    ? { text: fallback }
    : message;
}

export function eventAddress(event: ChannelEvent): ChannelAddress {
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

function resolveAcknowledgement(
  options: string | false | ChannelAgentAcknowledgementOptions | undefined,
): ChannelAgentAcknowledgementOptions | false {
  if (options === undefined || options === false) return false;

  const resolved: ChannelAgentAcknowledgementOptions =
    typeof options === "string" ? { reaction: options } : options;

  if (resolved.reaction.length === 0) {
    throw new TypeError("Channel agent acknowledgement reaction must not be empty");
  }

  if (resolved.completeReaction !== undefined && resolved.completeReaction.length === 0) {
    throw new TypeError("Channel agent acknowledgement complete reaction must not be empty");
  }

  return resolved;
}

function resolveInteractionOptions<RawEvent>(
  options: false | ChannelAgentInteractionOptions<RawEvent> | undefined,
): ResolvedChannelAgentOptions<RawEvent, unknown>["interactions"] {
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

function defaultRenderOutcome<Output>(
  request: Readonly<{
    outcome: AgentOutcome<Output>;
    event: ChannelEvent;
  }>,
): string {
  const outcome = request.outcome;

  if (outcome.text.length > 0) return outcome.text;

  if (outcome.type === "blocked") return outcome.message ?? outcome.reason;

  if (outcome.type === "interaction") {
    return "The agent needs additional input that this channel cannot handle yet.";
  }

  return "";
}
