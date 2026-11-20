import type { AgentOutcome } from "@anvia/core";
import type { Channel, ChannelMessageEvent, SentChannelMessage } from "@anvia/channel";
import { messageParts, supportsMessageEdits } from "./delivery.js";
import { timedOutError } from "./options.js";
import type { ChannelAgentExecutor, ChannelAgentRunInput } from "./types.js";

export function runWithTimeout<Value>(
  signal: AbortSignal,
  runTimeoutMs: number,
  run: (runSignal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);

  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout =
    runTimeoutMs === Number.POSITIVE_INFINITY
      ? new Promise<never>(() => undefined)
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(timedOutError());
            reject(timedOutError());
          }, runTimeoutMs);
        });
  const result = Promise.resolve().then(() => run(controller.signal));
  void result.catch(() => undefined);
  return Promise.race([result, timeout]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  });
}

export async function streamAgentOutcome<RawEvent, Output>(
  request: Readonly<{
    agent: ChannelAgentExecutor<Output>;
    channel: Channel<RawEvent>;
    input: ChannelAgentRunInput;
    event: ChannelMessageEvent<RawEvent>;
    provisional: SentChannelMessage | undefined;
    editIntervalMs: number;
    onDeliveryError: (error: unknown) => Promise<void>;
  }>,
): Promise<Readonly<{ outcome: AgentOutcome<Output>; deliveredText: string }>> {
  const { agent, channel, input, provisional, editIntervalMs, onDeliveryError } = request;
  const signal = input.abortSignal;
  const stream = agent.stream(input);
  const result = stream.result;

  void result.catch(() => undefined);

  let text = "";
  let deliveredText = "";
  let lastEditAt = Date.now();
  const edit = supportsMessageEdits(channel) ? channel.edit : undefined;

  for await (const delta of stream.textStream) {
    if (signal.aborted) break;

    text += delta;

    if (provisional === undefined || edit === undefined || text.length === 0) continue;

    const now = Date.now();

    if (now - lastEditAt < editIntervalMs) continue;

    const firstPart = messageParts(channel, { text })[0];

    if (firstPart === undefined || firstPart.text === deliveredText) continue;

    try {
      await edit.call(channel, provisional, firstPart);
      deliveredText = firstPart.text;
      lastEditAt = now;
    } catch (error) {
      await onDeliveryError(error);
      lastEditAt = now;
    }
  }

  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : timedOutError();
  }

  return { outcome: await result, deliveredText };
}
