import type { ChannelAttachmentData, ChannelOutboundAttachment } from "@anvia/channel";

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export type TelegramUser = Readonly<{
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}>;

export type TelegramChat = Readonly<{
  id: number;
  type: TelegramChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}>;

export type TelegramEntityType = "mention" | "text_mention" | "bot_command" | (string & {});

export type TelegramMessageEntity = Readonly<{
  type: TelegramEntityType;
  offset: number;
  length: number;
  user?: TelegramUser;
}>;

export type TelegramPhotoSize = Readonly<{
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}>;

export type TelegramMediaFile = Readonly<{
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}>;

export type TelegramMessage = Readonly<{
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  entities?: readonly TelegramMessageEntity[];
  caption?: string;
  caption_entities?: readonly TelegramMessageEntity[];
  photo?: readonly TelegramPhotoSize[];
  document?: TelegramMediaFile;
  audio?: TelegramMediaFile;
  video?: TelegramMediaFile;
  voice?: TelegramMediaFile;
  reply_to_message?: TelegramMessage;
}>;

export type TelegramCallbackQuery = Readonly<{
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}>;

export type TelegramReactionType =
  | Readonly<{ type: "emoji"; emoji: string }>
  | Readonly<{ type: "custom_emoji"; custom_emoji_id: string }>
  | Readonly<{ type: "paid" }>;

export type TelegramMessageReactionUpdated = Readonly<{
  chat: TelegramChat;
  message_id: number;
  user?: TelegramUser;
  actor_chat?: TelegramChat;
  date: number;
  old_reaction: readonly TelegramReactionType[];
  new_reaction: readonly TelegramReactionType[];
}>;

export type TelegramUpdate = Readonly<{
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  message_reaction?: TelegramMessageReactionUpdated;
  callback_query?: TelegramCallbackQuery;
}>;

export type TelegramGetUpdatesRequest = Readonly<{
  offset?: number;
  limit?: number;
  timeout?: number;
  allowed_updates?: readonly string[];
}>;

export type TelegramSendMessageRequest = Readonly<{
  chat_id: number | string;
  message_thread_id?: number;
  text: string;
  reply_parameters?: Readonly<{ message_id: number }>;
  reply_markup?: TelegramInlineKeyboardMarkup;
}>;

export type TelegramSendAttachmentRequest = Readonly<{
  chat_id: number | string;
  message_thread_id?: number;
  caption?: string;
  attachment: ChannelOutboundAttachment;
  reply_parameters?: Readonly<{ message_id: number }>;
  reply_markup?: TelegramInlineKeyboardMarkup;
}>;

export type TelegramEditMessageTextRequest = Readonly<{
  chat_id: number | string;
  message_id: number;
  text: string;
  reply_markup?: TelegramInlineKeyboardMarkup;
}>;

export type TelegramInlineKeyboardButton = Readonly<{
  text: string;
  callback_data: string;
}>;

export type TelegramInlineKeyboardMarkup = Readonly<{
  inline_keyboard: readonly (readonly TelegramInlineKeyboardButton[])[];
}>;

export type TelegramAnswerCallbackQueryRequest = Readonly<{
  callback_query_id: string;
}>;

export type TelegramDeleteMessageRequest = Readonly<{
  chat_id: number | string;
  message_id: number;
}>;

export type TelegramSendChatActionRequest = Readonly<{
  chat_id: number | string;
  message_thread_id?: number;
  action: "typing";
}>;

export type TelegramSetMessageReactionRequest = Readonly<{
  chat_id: number | string;
  message_id: number;
  reaction: readonly Readonly<{ type: "emoji"; emoji: string }>[];
}>;

export interface TelegramBotApi {
  getMe(signal?: AbortSignal): Promise<TelegramUser>;
  getUpdates(
    request: TelegramGetUpdatesRequest,
    signal?: AbortSignal,
  ): Promise<readonly TelegramUpdate[]>;
  sendMessage(request: TelegramSendMessageRequest, signal?: AbortSignal): Promise<TelegramMessage>;
  sendAttachment(
    request: TelegramSendAttachmentRequest,
    signal?: AbortSignal,
  ): Promise<TelegramMessage>;
  editMessageText(
    request: TelegramEditMessageTextRequest,
    signal?: AbortSignal,
  ): Promise<TelegramMessage | true>;
  answerCallbackQuery(
    request: TelegramAnswerCallbackQueryRequest,
    signal?: AbortSignal,
  ): Promise<true>;
  deleteMessage(request: TelegramDeleteMessageRequest, signal?: AbortSignal): Promise<true>;
  sendChatAction(request: TelegramSendChatActionRequest, signal?: AbortSignal): Promise<true>;
  setMessageReaction(
    request: TelegramSetMessageReactionRequest,
    signal?: AbortSignal,
  ): Promise<true>;
  downloadFile(fileId: string, signal?: AbortSignal): Promise<ChannelAttachmentData>;
}
