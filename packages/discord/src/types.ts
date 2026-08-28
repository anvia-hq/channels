export type DiscordGatewayUser = Readonly<{
  id: string;
  username: string;
  globalName?: string;
  bot: boolean;
}>;

export type DiscordGatewayAttachment = Readonly<{
  id: string;
  url: string;
  filename: string;
  mediaType?: string;
  size: number;
}>;

export type DiscordGatewayMessage = Readonly<{
  id: string;
  channelId: string;
  guildId?: string;
  parentChannelId?: string;
  content: string;
  attachments: readonly DiscordGatewayAttachment[];
  author: DiscordGatewayUser;
  bot: DiscordGatewayUser;
  memberDisplayName?: string;
  direct: boolean;
  thread: boolean;
  system: boolean;
  mentionedBot: boolean;
}>;

export type DiscordGatewaySentMessage = Readonly<{
  id: string;
  channelId: string;
}>;

export type DiscordGatewayHandler = (message: DiscordGatewayMessage) => Promise<void>;

export interface DiscordGateway {
  start(handler: DiscordGatewayHandler): Promise<void>;
  stop(): Promise<void>;
  send(channelId: string, text: string): Promise<DiscordGatewaySentMessage>;
  edit(channelId: string, messageId: string, text: string): Promise<void>;
}
