import type { ChannelAttachmentData } from "@anvia/channel";

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

export type TelegramUpdate = Readonly<{
  update_id: number;
  message?: TelegramMessage;
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

export interface TelegramBotApi {
  getMe(signal?: AbortSignal): Promise<TelegramUser>;
  getUpdates(
    request: TelegramGetUpdatesRequest,
    signal?: AbortSignal,
  ): Promise<readonly TelegramUpdate[]>;
  sendMessage(request: TelegramSendMessageRequest, signal?: AbortSignal): Promise<TelegramMessage>;
  editMessageText(
    request: TelegramEditMessageTextRequest,
    signal?: AbortSignal,
  ): Promise<TelegramMessage | true>;
  answerCallbackQuery(
    request: TelegramAnswerCallbackQueryRequest,
    signal?: AbortSignal,
  ): Promise<true>;
  downloadFile(fileId: string, signal?: AbortSignal): Promise<ChannelAttachmentData>;
}
