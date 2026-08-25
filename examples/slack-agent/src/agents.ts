import { Agent, type CompletionModel, type MemoryStore } from "@anvia/core";

export function createAgent(model: CompletionModel, memoryStore: MemoryStore): Agent {
  return new Agent({
    id: "slack-assistant",
    model,
    instructions:
      "You are a concise and helpful assistant. Answer in the language used by the person messaging you.",
    memory: {
      store: memoryStore,
      savePolicy: "turn",
    },
  });
}
