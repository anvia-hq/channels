import type { SlackAgentConfig } from "./types.js";

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): SlackAgentConfig {
  const openAiBaseUrl = environment.OPENAI_BASE_URL?.trim() || undefined;

  return {
    slackAppToken: requiredEnvironmentVariable(environment, "SLACK_APP_TOKEN"),
    slackBotToken: requiredEnvironmentVariable(environment, "SLACK_BOT_TOKEN"),
    openAiApiKey: requiredEnvironmentVariable(environment, "OPENAI_API_KEY"),
    ...(openAiBaseUrl === undefined ? {} : { openAiBaseUrl }),
    modelId: environment.OPENAI_MODEL?.trim() || "gpt-5.6",
    memoryPath: environment.ANVIA_MEMORY_PATH?.trim() || "./data/slack-agent.sqlite",
  };
}

function requiredEnvironmentVariable(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
