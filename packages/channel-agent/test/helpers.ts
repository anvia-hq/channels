import type { AgentOutcome, Usage } from "@anvia/core";
import type {
  Channel,
  ChannelAddress,
  ChannelEventHandler,
  ChannelMessage,
  ChannelMessageEvent,
  SentChannelMessage,
} from "@anvia/channel";

export class FakeChannel implements Channel {
  readonly platform = "test";
  readonly sent: Array<{ address: ChannelAddress; message: ChannelMessage }> = [];
  readonly edits: Array<{ sent: SentChannelMessage; message: ChannelMessage }> = [];
  startCount = 0;
  stopCount = 0;
  stopError: unknown = undefined;
  private handler: ChannelEventHandler | undefined;

  async start(handler: ChannelEventHandler): Promise<void> {
    this.startCount += 1;
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    if (this.stopError !== undefined) throw this.stopError;
  }

  async send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage> {
    this.sent.push({ address, message });
    return { id: String(this.sent.length), address };
  }

  async edit(sent: SentChannelMessage, message: ChannelMessage): Promise<void> {
    this.edits.push({ sent, message });
  }

  async emit(event: ChannelMessageEvent): Promise<void> {
    if (this.handler === undefined) throw new Error("Fake channel is not running");
    await this.handler(event);
  }
}

export type MessageEventOverrides = Readonly<{
  id?: string;
  platform?: string;
  accountId?: string;
  conversation?: ChannelMessageEvent["conversation"];
  sender?: ChannelMessageEvent["sender"];
  text?: string;
  mentionedBot?: boolean;
}>;

export function messageEvent(overrides: MessageEventOverrides = {}): ChannelMessageEvent {
  return {
    type: "message",
    id: overrides.id ?? "event-1",
    platform: overrides.platform ?? "telegram",
    accountId: overrides.accountId ?? "42",
    conversation: overrides.conversation ?? { id: "chat-1", kind: "direct" },
    sender: overrides.sender ?? { id: "user-1", displayName: "User", bot: false },
    text: overrides.text ?? "hello",
    mentionedBot: overrides.mentionedBot ?? false,
    raw: {},
  };
}

const usage: Usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
};

export function agentResponse<Output = string>(
  text: string,
  output?: Output,
): AgentOutcome<Output> {
  return {
    type: "response",
    runId: "run-1",
    text,
    output: output ?? (text as Output),
    usage,
    messages: [],
  };
}

export type Deferred<Value> = Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}>;

export function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(error) {
      rejectPromise?.(error);
    },
  };
}

export async function* textStream(...deltas: string[]): AsyncIterable<string> {
  for (const delta of deltas) yield delta;
}
