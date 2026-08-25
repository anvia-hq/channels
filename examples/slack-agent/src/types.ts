export type SlackAgentConfig = Readonly<{
  slackAppToken: string;
  slackBotToken: string;
  openAiApiKey: string;
  openAiBaseUrl?: string;
  modelId: string;
  memoryPath: string;
}>;

export interface SlackAgentApplication {
  readonly modelId: string;

  start(): Promise<void>;
  stop(): Promise<void>;
}
