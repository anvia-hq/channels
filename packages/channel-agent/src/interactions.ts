import type {
  AgentContinuation,
  AgentInteractionRequest,
  AgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import type { ChannelMessageEvent } from "@anvia/channel";
import { channelConversationKey } from "./defaults.js";

const MAX_APPROVAL_INPUT_PREVIEW_LENGTH = 1_000;
const REDACTED_VALUE = "[redacted]";

export type PendingChannelAgentInteraction = Readonly<{
  continuation: AgentContinuation;
  interaction: AgentInteractionRequest;
}>;

export interface ChannelAgentInteractionStore {
  get(
    key: string,
  ):
    | PendingChannelAgentInteraction
    | undefined
    | Promise<PendingChannelAgentInteraction | undefined>;
  set(key: string, pending: PendingChannelAgentInteraction): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

export class MemoryChannelAgentInteractionStore implements ChannelAgentInteractionStore {
  private readonly pending = new Map<string, PendingChannelAgentInteraction>();

  get(key: string): PendingChannelAgentInteraction | undefined {
    return this.pending.get(key);
  }

  set(key: string, pending: PendingChannelAgentInteraction): void {
    this.pending.set(key, pending);
  }

  delete(key: string): void {
    this.pending.delete(key);
  }
}

export function channelInteractionKey(event: ChannelMessageEvent): string {
  return JSON.stringify([channelConversationKey(event), event.sender.id]);
}

export function renderChannelAgentInteraction(pending: PendingChannelAgentInteraction): string {
  const interaction = pending.interaction;
  if (interaction.type === "tool-approval") {
    const reason = interaction.reason === undefined ? "" : `\n${interaction.reason}`;
    const input = renderApprovalInput(interaction.input);
    return `Approve tool "${interaction.toolName}"?\nInput:\n${input}${reason}\nReply "approve" or "deny".`;
  }

  const questions = interaction.questions.map((question, index) => {
    const heading =
      interaction.questions.length === 1 ? question.text : `${index + 1}. ${question.text}`;
    const choices = question.choices?.map((choice) => `- ${choice.label}`).join("\n");
    return choices === undefined ? heading : `${heading}\n${choices}`;
  });
  const instruction =
    interaction.questions.length === 1
      ? "Reply with your answer."
      : "Reply with one answer per line in the same order.";
  return `${questions.join("\n\n")}\n${instruction}`;
}

function renderApprovalInput(input: unknown): string {
  const seen = new WeakSet<object>();
  let preview: string;
  try {
    preview =
      JSON.stringify(
        input,
        (key, value: unknown) => {
          if (key.length > 0 && isSensitiveInputKey(key)) return REDACTED_VALUE;
          if (typeof value === "bigint") return value.toString();
          if (typeof value !== "object" || value === null) return value;
          if (seen.has(value)) return "[circular]";
          seen.add(value);
          return value;
        },
        2,
      ) ?? String(input);
  } catch {
    preview = "[unavailable]";
  }

  if (preview.length <= MAX_APPROVAL_INPUT_PREVIEW_LENGTH) return preview;
  const suffix = "\n… [truncated]";
  return `${preview.slice(0, MAX_APPROVAL_INPUT_PREVIEW_LENGTH - suffix.length)}${suffix}`;
}

function isSensitiveInputKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLocaleLowerCase("en-US");
  return [
    "apikey",
    "auth",
    "authorization",
    "cookie",
    "credential",
    "password",
    "privatekey",
    "secret",
    "token",
  ].some((sensitive) => normalized.includes(sensitive));
}

export function parseChannelAgentInteractionResponse(
  event: ChannelMessageEvent,
  pending: PendingChannelAgentInteraction,
): AgentInteractionResponse | undefined {
  const interaction = pending.interaction;
  if (interaction.type === "tool-approval") {
    return parseApproval(event.text);
  }

  const lines = responseLines(event.text, interaction.questions.length);
  if (lines === undefined) return undefined;
  const answers: { questionId: string; value: string }[] = [];
  for (const [index, question] of interaction.questions.entries()) {
    const value = resolveQuestionValue(lines[index] ?? "", question);
    if (value === undefined) return undefined;
    answers.push({ questionId: question.id, value });
  }
  return { type: "tool-question", answers };
}

function parseApproval(text: string): AgentInteractionResponse | undefined {
  const answer = text.trim().toLocaleLowerCase("en-US");
  if (["approve", "approved", "yes", "y"].includes(answer)) {
    return { type: "tool-approval", approved: true };
  }
  if (["deny", "denied", "no", "n", "reject", "rejected"].includes(answer)) {
    return { type: "tool-approval", approved: false };
  }
  return undefined;
}

function responseLines(text: string, expected: number): readonly string[] | undefined {
  if (expected === 1) {
    const answer = text.trim();
    return answer.length === 0 ? undefined : [answer];
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => line.replace(new RegExp(`^${index + 1}[.)]\\s*`), ""));
  return lines.length === expected ? lines : undefined;
}

function resolveQuestionValue(
  answer: string,
  question: Extract<AgentInteractionRequest, { type: "tool-question" }>["questions"][number],
): string | undefined {
  const value = answer.trim();
  if (value.length === 0) return undefined;
  const choice = question.choices?.find(
    (candidate) =>
      candidate.value.toLocaleLowerCase("en-US") === value.toLocaleLowerCase("en-US") ||
      candidate.label.toLocaleLowerCase("en-US") === value.toLocaleLowerCase("en-US"),
  );
  if (choice !== undefined) return choice.value;
  return question.choices === undefined || question.allowCustom === true ? value : undefined;
}
