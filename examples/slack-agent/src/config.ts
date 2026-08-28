import type { SlackAgentConfig } from "./types.js";

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): SlackAgentConfig {
  const openAiBaseUrl = environment.OPENAI_BASE_URL?.trim() || undefined;

  const config: {
    slackAppToken: string;
    slackBotToken: string;
    openAiApiKey: string;
    openAiBaseUrl?: string;
    modelId: string;
    memoryPath: string;
  } = {
    slackAppToken: requiredEnvironmentVariable(environment, "SLACK_APP_TOKEN"),
    slackBotToken: requiredEnvironmentVariable(environment, "SLACK_BOT_TOKEN"),
    openAiApiKey: requiredEnvironmentVariable(environment, "OPENAI_API_KEY"),
    modelId: environment.OPENAI_MODEL?.trim() || "gpt-5.6",
    memoryPath: environment.ANVIA_MEMORY_PATH?.trim() || "./data/slack-agent.sqlite",
  };
  if (openAiBaseUrl !== undefined) config.openAiBaseUrl = openAiBaseUrl;
  return config;
}

function requiredEnvironmentVariable(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
