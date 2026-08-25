import type { CompletionModel } from "@anvia/core";
import { OpenAIClient } from "@anvia/openai";
import type { DiscordAgentConfig } from "./types.js";

export function createModel(config: DiscordAgentConfig): CompletionModel {
  const openAi = new OpenAIClient({
    apiKey: config.openAiApiKey,
    ...(config.openAiBaseUrl === undefined ? {} : { baseUrl: config.openAiBaseUrl }),
  });

  return openAi.completionModel({
    modelId: config.modelId,
    api: "responses",
  });
}
