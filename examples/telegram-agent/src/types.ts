export type TelegramAgentConfig = Readonly<{
  telegramToken: string;
  openAiApiKey: string;
  openAiBaseUrl?: string;
  modelId: string;
  memoryPath: string;
}>;

export interface TelegramAgentApplication {
  readonly modelId: string;

  start(): Promise<void>;
  stop(): Promise<void>;
}
