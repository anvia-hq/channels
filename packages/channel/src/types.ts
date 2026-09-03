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

export type ChannelOutboundAttachment = Readonly<{
  type: ChannelAttachmentType;
  mediaType: string;
  filename?: string;
  size?: number;
  source: ChannelAttachmentData;
}>;

export type ChannelReply = Readonly<{
  messageId: string;
  sender?: ChannelSender;
  text?: string;
}>;

export type ChannelActionStyle = "default" | "primary" | "danger";

export type ChannelAction = Readonly<{
  /** Opaque application identifier returned by the platform when this action is selected. */
  id: string;
  label: string;
  style?: ChannelActionStyle;
}>;

export type ChannelCapabilities = Readonly<{
  /** Whether messages may include actions and the channel can emit action events. */
  actions: boolean;
  /** Outbound attachment kinds accepted by `send`. */
  outboundAttachments?: readonly ChannelAttachmentType[];
  replies?: boolean;
  typing?: boolean;
  reactions?: boolean;
  delete?: boolean;
  messageEdits?: boolean;
}>;

export type ChannelMessageEvent<RawEvent = unknown> = Readonly<{
  type: "message";
  id: string;
  platform: string;
  accountId?: string;
  conversation: ChannelConversation;
  sender: ChannelSender;
  text: string;
  attachments: readonly ChannelAttachment[];
  replyTo?: ChannelReply;
  mentionedBot: boolean;
  raw: RawEvent;
}>;

export type ChannelMessageEditedEvent<RawEvent = unknown> = Readonly<{
  type: "message-edited";
  id: string;
  platform: string;
  accountId?: string;
  conversation: ChannelConversation;
  sender: ChannelSender;
  messageId: string;
  text: string;
  attachments: readonly ChannelAttachment[];
  raw: RawEvent;
}>;

export type ChannelMessageDeletedEvent<RawEvent = unknown> = Readonly<{
  type: "message-deleted";
  id: string;
  platform: string;
  accountId?: string;
  conversation: ChannelConversation;
  messageId: string;
  raw: RawEvent;
}>;

export type ChannelReactionEvent<RawEvent = unknown> = Readonly<{
  type: "reaction";
  id: string;
  platform: string;
  accountId?: string;
  conversation: ChannelConversation;
  sender: ChannelSender;
  messageId: string;
  reaction: string;
  removed: boolean;
  raw: RawEvent;
}>;

export type ChannelActionEvent<RawEvent = unknown> = Readonly<{
  type: "action";
  id: string;
  platform: string;
  accountId?: string;
  conversation: ChannelConversation;
  sender: ChannelSender;
  messageId: string;
  actionId: string;
  raw: RawEvent;
}>;

export type ChannelEvent<RawEvent = unknown> =
  | ChannelMessageEvent<RawEvent>
  | ChannelActionEvent<RawEvent>
  | ChannelMessageEditedEvent<RawEvent>
  | ChannelMessageDeletedEvent<RawEvent>
  | ChannelReactionEvent<RawEvent>;

export type ChannelMessage = Readonly<{
  text: string;
  actions?: readonly ChannelAction[];
  attachments?: readonly ChannelOutboundAttachment[];
  replyToMessageId?: string;
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
  /** Optional so existing text-only custom adapters remain source-compatible. */
  readonly capabilities?: ChannelCapabilities;

  splitMessage(message: ChannelMessage): readonly ChannelMessage[];
  loadAttachment?(
    event: ChannelMessageEvent<RawEvent>,
    attachment: ChannelAttachment,
    signal?: AbortSignal,
  ): Promise<ChannelAttachmentData>;
  start(handler: ChannelEventHandler<RawEvent>): Promise<void>;
  stop(): Promise<void>;
  send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage>;
  edit?(sent: SentChannelMessage, message: ChannelMessage): Promise<void>;
  delete?(sent: SentChannelMessage): Promise<void>;
  showTyping?(address: ChannelAddress): Promise<void>;
  react?(sent: SentChannelMessage, reaction: string): Promise<void>;
}
