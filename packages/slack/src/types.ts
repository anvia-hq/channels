export type SlackChannelType = "channel" | "group" | "im" | "mpim" | "app_home";

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
  botUserId: string;
}>;

export type SlackSentMessage = Readonly<{
  channelId: string;
  timestamp: string;
  threadTimestamp?: string;
}>;

export type SlackTransportHandler = (message: SlackSocketMessage) => Promise<void>;

export interface SlackTransport {
  start(handler: SlackTransportHandler): Promise<void>;
  stop(): Promise<void>;
  send(
    channelId: string,
    threadTimestamp: string | undefined,
    text: string,
  ): Promise<SlackSentMessage>;
  edit(channelId: string, timestamp: string, text: string): Promise<void>;
}
