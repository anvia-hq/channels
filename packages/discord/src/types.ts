import type { ChannelMessage } from "@anvia/channel";

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
  type: "message";
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

export type DiscordGatewayAction = Readonly<{
  type: "action";
  id: string;
  channelId: string;
  guildId?: string;
  parentChannelId?: string;
  messageId: string;
  actionId: string;
  user: DiscordGatewayUser;
  bot: DiscordGatewayUser;
  direct: boolean;
  thread: boolean;
}>;

export type DiscordGatewayEvent = DiscordGatewayMessage | DiscordGatewayAction;

export type DiscordGatewaySentMessage = Readonly<{
  id: string;
  channelId: string;
}>;

export type DiscordGatewayHandler = (event: DiscordGatewayEvent) => Promise<void>;

export interface DiscordGateway {
  start(handler: DiscordGatewayHandler): Promise<void>;
  stop(): Promise<void>;
  send(channelId: string, message: ChannelMessage): Promise<DiscordGatewaySentMessage>;
  edit(channelId: string, messageId: string, message: ChannelMessage): Promise<void>;
}
