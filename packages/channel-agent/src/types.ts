import type { AgentOutcome, AgentPrompt, MemoryScope } from "@anvia/core";
import type { Channel, ChannelMessageEvent } from "@anvia/channel";

export type ChannelAgentRunInput = Readonly<{
  prompt: AgentPrompt;
  session: MemoryScope;
  abortSignal: AbortSignal;
}>;

export type ChannelAgentStream<Output = string> = Readonly<{
  textStream: AsyncIterable<string>;
  result: Promise<AgentOutcome<Output>>;
}>;

export interface ChannelAgentExecutor<Output = string> {
  readonly model?: Readonly<{
    capabilities: Readonly<{
      streaming: boolean;
    }>;
  }>;

  generate(input: ChannelAgentRunInput): Promise<AgentOutcome<Output>>;
  stream(input: ChannelAgentRunInput): ChannelAgentStream<Output>;
}

export type ChannelAgentStreamingOptions = Readonly<{
  enabled?: boolean;
  editIntervalMs?: number;
  placeholder?: string | false;
}>;

export type ChannelAgentErrorContext<RawEvent = unknown> = Readonly<{
  stage: "filter" | "prepare" | "agent" | "delivery";
  event: ChannelMessageEvent<RawEvent>;
}>;

export type ChannelAgentOptions<RawEvent = unknown, Output = string> = Readonly<{
  channel: Channel<RawEvent>;
  agent: ChannelAgentExecutor<Output>;
  shouldHandle?: (event: ChannelMessageEvent<RawEvent>) => boolean | Promise<boolean>;
  createPrompt?: (event: ChannelMessageEvent<RawEvent>) => AgentPrompt | Promise<AgentPrompt>;
  createSession?: (event: ChannelMessageEvent<RawEvent>) => MemoryScope | Promise<MemoryScope>;
  renderOutcome?: (
    outcome: AgentOutcome<Output>,
    event: ChannelMessageEvent<RawEvent>,
  ) => string | Promise<string>;
  streaming?: ChannelAgentStreamingOptions;
  errorMessage?: string | false;
  emptyResponseMessage?: string;
  onError?: (error: unknown, context: ChannelAgentErrorContext<RawEvent>) => void | Promise<void>;
}>;
