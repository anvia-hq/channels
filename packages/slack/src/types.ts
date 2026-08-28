import type { ChannelAttachmentData, ChannelMessage } from "@anvia/channel";

export type SlackChannelType = "channel" | "group" | "im" | "mpim" | "app_home";

export type SlackFile = Readonly<{
  id: string;
  name: string;
  mediaType: string;
  size?: number;
  privateDownloadUrl: string;
}>;

export type SlackIdentity = Readonly<{
  teamId: string;
  botUserId: string;
}>;

export type SlackSocketMessage = Readonly<{
  eventId: string;
  type: "message" | "app_mention";
  teamId: string;
  channelId: string;
  channelType: SlackChannelType;
  timestamp: string;
  threadTimestamp?: string;
  senderId: string;
  senderDisplayName?: string;
  senderBot: boolean;
  text: string;
  files: readonly SlackFile[];
  botUserId: string;
}>;

export type SlackSocketAction = Readonly<{
  type: "action";
  eventId: string;
  teamId: string;
  channelId: string;
  channelType: SlackChannelType;
  messageTimestamp: string;
  threadTimestamp?: string;
  senderId: string;
  senderDisplayName?: string;
  actionId: string;
  actionTimestamp: string;
  botUserId: string;
}>;

export type SlackSocketEvent = SlackSocketMessage | SlackSocketAction;

export type SlackSentMessage = Readonly<{
  channelId: string;
  timestamp: string;
  threadTimestamp?: string;
}>;

export type SlackTransportHandler = (event: SlackSocketEvent) => Promise<void>;

export interface SlackTransport {
  start(handler: SlackTransportHandler): Promise<void>;
  stop(): Promise<void>;
  send(
    channelId: string,
    threadTimestamp: string | undefined,
    message: ChannelMessage,
  ): Promise<SlackSentMessage>;
  edit(channelId: string, timestamp: string, message: ChannelMessage): Promise<void>;
  loadAttachment(file: SlackFile, signal?: AbortSignal): Promise<ChannelAttachmentData>;
}
