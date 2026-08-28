import type { CompletionModel } from "@anvia/core";
import { OpenAIClient } from "@anvia/openai";
import type { DiscordAgentConfig } from "./types.js";

export function createModel(config: DiscordAgentConfig): CompletionModel {
  let openAi: OpenAIClient;
  if (config.openAiBaseUrl === undefined) {
    openAi = new OpenAIClient({ apiKey: config.openAiApiKey });
  } else {
    openAi = new OpenAIClient({ apiKey: config.openAiApiKey, baseUrl: config.openAiBaseUrl });
  }

  return openAi.completionModel({
    modelId: config.modelId,
    api: "responses",
  });
}
