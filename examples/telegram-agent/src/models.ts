import type { CompletionModel } from "@anvia/core";
import { OpenAIClient } from "@anvia/openai";
import type { TelegramAgentConfig } from "./types.js";

export function createModel(config: TelegramAgentConfig): CompletionModel {
  const openAi =
    config.openAiBaseUrl === undefined
      ? new OpenAIClient({ apiKey: config.openAiApiKey })
      : new OpenAIClient({ apiKey: config.openAiApiKey, baseUrl: config.openAiBaseUrl });

  return openAi.completionModel({
    modelId: config.modelId,
    api: "responses",
  });
}
