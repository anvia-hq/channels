import type { AgentOutcome, AgentPrompt, MemoryScope } from "@anvia/core";
import type { AgentContinuation, AgentInteractionResponse } from "@anvia/core/agent/interactions";
import type {
  Channel,
  ChannelActionEvent,
  ChannelEvent,
  ChannelMessage,
  ChannelMessageEvent,
} from "@anvia/channel";
import type {
  ChannelAgentInteractionStore,
  PendingChannelAgentInteraction,
} from "./interactions.js";

export type ChannelAgentRunInput = Readonly<{
  prompt: AgentPrompt;
  session?: MemoryScope;
  abortSignal: AbortSignal;
}>;

export type ChannelAgentStream<Output = string> = Readonly<{
  textStream: AsyncIterable<string>;
  result: Promise<AgentOutcome<Output>>;
}>;

export interface ChannelAgentExecutor<Output = string> {
  readonly memory?: unknown;
  readonly model?: Readonly<{
    capabilities: Readonly<{
      streaming: boolean;
    }>;
  }>;

  generate(input: ChannelAgentRunInput): Promise<AgentOutcome<Output>>;
  stream(input: ChannelAgentRunInput): ChannelAgentStream<Output>;
  resume?(
    continuation: AgentContinuation,
    response: AgentInteractionResponse,
    settings: Readonly<{ abortSignal: AbortSignal }>,
  ): Promise<AgentOutcome<Output>>;
}

export type ChannelAgentStreamingOptions = Readonly<{
  enabled?: boolean;
  editIntervalMs?: number;
  placeholder?: string | false;
}>;

export type ChannelAgentMultimodalOptions = Readonly<{
  maximumAttachments?: number;
  maximumAttachmentBytes?: number;
  maximumTotalAttachmentBytes?: number;
  attachmentConcurrency?: number;
}>;

export type ChannelAgentPromptContext<RawEvent = unknown> = Readonly<{
  channel: Channel<RawEvent>;
  abortSignal: AbortSignal;
}>;

export type ChannelAgentErrorContext<RawEvent = unknown> = Readonly<{
  stage: "filter" | "prepare" | "interaction" | "agent" | "delivery";
  event: ChannelEvent<RawEvent>;
}>;

export type ChannelAgentInteractionOptions<RawEvent = unknown> = Readonly<{
  store?: ChannelAgentInteractionStore;
  render?: (
    pending: PendingChannelAgentInteraction,
    event: ChannelEvent<RawEvent>,
  ) => string | ChannelMessage | Promise<string | ChannelMessage>;
  parseResponse?: (
    event: ChannelMessageEvent<RawEvent>,
    pending: PendingChannelAgentInteraction,
  ) => AgentInteractionResponse | undefined | Promise<AgentInteractionResponse | undefined>;
  parseAction?: (
    event: ChannelActionEvent<RawEvent>,
    pending: PendingChannelAgentInteraction,
  ) => AgentInteractionResponse | undefined | Promise<AgentInteractionResponse | undefined>;
  invalidResponseMessage?: string;
  expiredInteractionMessage?: string;
}>;

export type ChannelAgentOptions<RawEvent = unknown, Output = string> = Readonly<{
  channel: Channel<RawEvent>;
  agent: ChannelAgentExecutor<Output>;
  shouldHandle?: (event: ChannelMessageEvent<RawEvent>) => boolean | Promise<boolean>;
  createPrompt?: (
    event: ChannelMessageEvent<RawEvent>,
    context: ChannelAgentPromptContext<RawEvent>,
  ) => AgentPrompt | Promise<AgentPrompt>;
  createSession?: (
    event: ChannelMessageEvent<RawEvent>,
  ) => MemoryScope | undefined | Promise<MemoryScope | undefined>;
  renderOutcome?: (
    outcome: AgentOutcome<Output>,
    event: ChannelEvent<RawEvent>,
  ) => string | Promise<string>;
  streaming?: ChannelAgentStreamingOptions;
  multimodal?: false | ChannelAgentMultimodalOptions;
  interactions?: false | ChannelAgentInteractionOptions<RawEvent>;
  errorMessage?: string | false;
  emptyResponseMessage?: string;
  onError?: (error: unknown, context: ChannelAgentErrorContext<RawEvent>) => void | Promise<void>;
}>;
