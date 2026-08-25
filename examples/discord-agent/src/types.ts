export type DiscordAgentConfig = Readonly<{
  discordToken: string;
  openAiApiKey: string;
  openAiBaseUrl?: string;
  modelId: string;
  memoryPath: string;
}>;

export interface DiscordAgentApplication {
  readonly modelId: string;

  start(): Promise<void>;
  stop(): Promise<void>;
}
