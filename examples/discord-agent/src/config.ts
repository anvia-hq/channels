import type { DiscordAgentConfig } from "./types.js";

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): DiscordAgentConfig {
  const openAiBaseUrl = environment.OPENAI_BASE_URL?.trim() || undefined;

  const config: {
    discordToken: string;
    openAiApiKey: string;
    openAiBaseUrl?: string;
    modelId: string;
    memoryPath: string;
  } = {
    discordToken: requiredEnvironmentVariable(environment, "DISCORD_BOT_TOKEN"),
    openAiApiKey: requiredEnvironmentVariable(environment, "OPENAI_API_KEY"),
    modelId: environment.OPENAI_MODEL?.trim() || "gpt-5.6",
    memoryPath: environment.ANVIA_MEMORY_PATH?.trim() || "./data/discord-agent.sqlite",
  };
  if (openAiBaseUrl !== undefined) config.openAiBaseUrl = openAiBaseUrl;
  return config;
}

function requiredEnvironmentVariable(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
