export type ChannelConversationKind = "direct" | "group" | "channel";

export type ChannelAddress = Readonly<{
  platform: string;
  accountId?: string;
  conversationId: string;
  threadId?: string;
}>;

export type ChannelConversation = Readonly<{
  id: string;
  kind: ChannelConversationKind;
  threadId?: string;
}>;

export type ChannelSender = Readonly<{
  id: string;
  displayName?: string;
  bot: boolean;
}>;

export type ChannelAttachmentType = "image" | "audio" | "video" | "file";

export type ChannelAttachment = Readonly<{
  id: string;
  type: ChannelAttachmentType;
  mediaType: string;
  filename?: string;
  size?: number;
}>;

export type ChannelAttachmentData =
  | Readonly<{ type: "url"; url: string }>
  /** Base64-encoded file bytes. */
  | Readonly<{ type: "data"; data: string }>;

export type ChannelMessageEvent<RawEvent = unknown> = Readonly<{
  type: "message";
  id: string;
  platform: string;
  accountId?: string;
  conversation: ChannelConversation;
  sender: ChannelSender;
  text: string;
  attachments: readonly ChannelAttachment[];
  mentionedBot: boolean;
  raw: RawEvent;
}>;

export type ChannelEvent<RawEvent = unknown> = ChannelMessageEvent<RawEvent>;

export type ChannelMessage = Readonly<{
  text: string;
}>;

export type SentChannelMessage = Readonly<{
  id: string;
  address: ChannelAddress;
}>;

export type ChannelEventHandler<RawEvent = unknown> = (
  event: ChannelEvent<RawEvent>,
) => Promise<void>;

export interface Channel<RawEvent = unknown> {
  readonly platform: string;

  splitMessage(message: ChannelMessage): readonly ChannelMessage[];
  loadAttachment?(
    event: ChannelMessageEvent<RawEvent>,
    attachment: ChannelAttachment,
    signal?: AbortSignal,
  ): Promise<ChannelAttachmentData>;
  start(handler: ChannelEventHandler<RawEvent>): Promise<void>;
  stop(): Promise<void>;
  send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage>;
  edit(sent: SentChannelMessage, message: ChannelMessage): Promise<void>;
}
