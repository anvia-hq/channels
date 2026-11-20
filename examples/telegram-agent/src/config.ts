import type { TelegramAgentConfig } from "./types.js";

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): TelegramAgentConfig {
  const openAiBaseUrl = environment.OPENAI_BASE_URL?.trim() || undefined;

  const config: {
    telegramToken: string;
    openAiApiKey: string;
    openAiBaseUrl?: string;
    modelId: string;
    memoryPath: string;
  } = {
    telegramToken: requiredEnvironmentVariable(environment, "TELEGRAM_BOT_TOKEN"),
    openAiApiKey: requiredEnvironmentVariable(environment, "OPENAI_API_KEY"),
    modelId: environment.OPENAI_MODEL?.trim() || "gpt-5.6",
    memoryPath: environment.ANVIA_MEMORY_PATH?.trim() || "./data/telegram-agent.sqlite",
  };

  if (openAiBaseUrl !== undefined) config.openAiBaseUrl = openAiBaseUrl;

  return config;
}

function requiredEnvironmentVariable(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();

  if (!value) throw new Error(`Missing required environment variable: ${name}`);

  return value;
}
