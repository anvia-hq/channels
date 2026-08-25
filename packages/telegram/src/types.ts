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

export type TelegramMessage = Readonly<{
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  entities?: readonly TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
}>;

export type TelegramUpdate = Readonly<{
  update_id: number;
  message?: TelegramMessage;
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
}>;

export type TelegramEditMessageTextRequest = Readonly<{
  chat_id: number | string;
  message_id: number;
  text: string;
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
}
