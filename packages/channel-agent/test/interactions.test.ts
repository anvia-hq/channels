import { describe, expect, it } from "vitest";
import {
  MemoryChannelAgentInteractionStore,
  channelInteractionActions,
  channelInteractionKey,
  parseChannelAgentActionResponse,
  parseChannelAgentInteractionResponse,
  renderChannelAgentInteraction,
} from "../src/index.js";
import { actionEvent, agentApproval, messageEvent } from "./helpers.js";

describe("channel agent interactions", () => {
  it("renders and parses approval interactions", () => {
    const outcome = agentApproval();
    if (outcome.type !== "interaction") throw new Error("Expected an interaction outcome");
    const pending = { continuation: outcome.continuation, interaction: outcome.interaction };

    expect(renderChannelAgentInteraction(pending)).toContain('"recipient": "person@example.com"');
    expect(renderChannelAgentInteraction(pending)).toContain('Reply "approve" or "deny".');
    expect(parseChannelAgentInteractionResponse(messageEvent({ text: "YES" }), pending)).toEqual({
      type: "tool-approval",
      approved: true,
    });
    expect(
      parseChannelAgentInteractionResponse(messageEvent({ text: "maybe" }), pending),
    ).toBeUndefined();
  });

  it("maps opaque native action IDs to interaction responses", () => {
    const outcome = agentApproval();
    if (outcome.type !== "interaction") throw new Error("Expected an interaction outcome");
    const pending = {
      continuation: outcome.continuation,
      interaction: outcome.interaction,
      actionToken: "opaque-token",
    };
    const actions = channelInteractionActions(pending);
    const approve = actions?.find((action) => action.label === "Approve");
    if (approve === undefined) throw new Error("Expected an approval action");

    expect(parseChannelAgentActionResponse(actionEvent(approve.id), pending)).toEqual({
      type: "tool-approval",
      approved: true,
    });
    expect(
      parseChannelAgentActionResponse(actionEvent("anvia:stale-token:approve"), pending),
    ).toBeUndefined();
  });

  it("redacts sensitive approval input and bounds its preview", () => {
    const outcome = agentApproval();
    if (outcome.type !== "interaction" || outcome.interaction.type !== "tool-approval") {
      throw new Error("Expected an approval interaction outcome");
    }
    const pending = {
      continuation: outcome.continuation,
      interaction: {
        ...outcome.interaction,
        input: {
          recipient: "person@example.com",
          apiKey: "do-not-render",
          nested: { password: "also-secret" },
          notes: "x".repeat(2_000),
          tailMarker: "must-not-fit",
        },
      },
    };

    const rendered = renderChannelAgentInteraction(pending);

    expect(rendered).toContain('"recipient": "person@example.com"');
    expect(rendered).toContain('"apiKey": "[redacted]"');
    expect(rendered).toContain('"password": "[redacted]"');
    expect(rendered).toContain("… [truncated]");
    expect(rendered).not.toContain("do-not-render");
    expect(rendered).not.toContain("also-secret");
    expect(rendered).not.toContain("must-not-fit");
  });

  it("normalizes labels and ordered answers for question interactions", () => {
    const interaction = {
      type: "tool-question" as const,
      id: "interaction-1",
      toolName: "ask",
      toolCallId: "tool-call-1",
      internalCallId: "internal-call-1",
      questions: [
        {
          id: "environment",
          text: "Which environment?",
          choices: [
            { label: "Production", value: "prod" },
            { label: "Staging", value: "stage" },
          ],
        },
        { id: "reason", text: "Why?" },
      ],
    };
    const pending = {
      interaction,
      continuation: {
        version: 1 as const,
        agentId: "agent",
        sourceRunId: "run-1",
        interaction,
        state: {},
      },
    };

    expect(
      parseChannelAgentInteractionResponse(
        messageEvent({ text: "1. Production\n2. Customer request" }),
        pending,
      ),
    ).toEqual({
      type: "tool-question",
      answers: [
        { questionId: "environment", value: "prod" },
        { questionId: "reason", value: "Customer request" },
      ],
    });
  });

  it("renders portable choices as actions and falls back for oversized labels", () => {
    const interaction = {
      type: "tool-question" as const,
      id: "interaction-1",
      toolName: "ask",
      toolCallId: "tool-call-1",
      internalCallId: "internal-call-1",
      questions: [
        {
          id: "environment",
          text: "Which environment?",
          choices: [
            { label: "Production", value: "prod" },
            { label: "Staging", value: "stage" },
          ],
        },
      ],
    };
    const pending = {
      interaction,
      actionToken: "opaque-token",
      continuation: {
        version: 1 as const,
        agentId: "agent",
        sourceRunId: "run-1",
        interaction,
        state: {},
      },
    };

    expect(channelInteractionActions(pending)?.map((action) => action.label)).toEqual([
      "Production",
      "Staging",
    ]);
    expect(
      channelInteractionActions({
        ...pending,
        interaction: {
          ...interaction,
          questions: [
            {
              id: "environment",
              text: "Which environment?",
              choices: [{ label: "x".repeat(81), value: "too-long" }],
            },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it("atomically takes only the expected pending interaction", () => {
    const outcome = agentApproval();
    if (outcome.type !== "interaction") throw new Error("Expected an interaction outcome");
    const pending = { continuation: outcome.continuation, interaction: outcome.interaction };
    const store = new MemoryChannelAgentInteractionStore();
    store.set("key", pending);

    expect(store.take("key", "different")).toBeUndefined();
    expect(store.take("key", outcome.interaction.id)).toBe(pending);
    expect(store.take("key", outcome.interaction.id)).toBeUndefined();
  });

  it("scopes pending interactions to the conversation and sender", () => {
    const first = messageEvent();
    const second = messageEvent({ sender: { id: "user-2", bot: false } });

    expect(channelInteractionKey(first)).not.toBe(channelInteractionKey(second));
  });
});
