import { createHash, timingSafeEqual } from "node:crypto";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Message as ChatMessage,
  RawMessage,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { markdownToPlainText, Message, parseMarkdown, toPlainText } from "chat";

/** Header the lweixin forwarder must send its shared webhook secret in. */
export const WECHAT_WEBHOOK_SECRET_HEADER = "X-Lweixin-Webhook-Secret";

const WECHAT_SEND_TIMEOUT_MS = 10_000;

export interface WechatAdapterConfig {
  /** Base URL of the lweixin HTTP API, without a trailing slash. */
  apiUrl: string;
  /** Token for `POST /api/message/send` (`X-Api-Token`). */
  apiToken: string;
  /** Shared secret the lweixin forwarder sends on every inbound delivery. */
  webhookSecret: string;
  /** Test seam; defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface WechatThreadId {
  conversationId: string;
}

/** One message as stored in lweixin's `api_messages` table. */
export interface WechatMessagePayload {
  msg_id?: string;
  new_msg_id?: string;
  type?: number;
  content?: string;
  create_time?: number;
  is_group?: boolean;
  group_sender?: string;
  from?: string;
  to?: string;
  seq?: number;
}

export interface WechatInboundPayload {
  bot_id?: string;
  synthetic?: boolean;
  message?: WechatMessagePayload;
}

export interface WechatRawMessage extends WechatMessagePayload {
  /** lweixin's at-least-once delivery id, stable across retries. */
  eventId?: string;
  botId?: string;
}

/**
 * Chat SDK adapter over a lweixin bridge. Inbound webhooks carry lweixin's
 * native message object; outbound sends call its REST API. WeChat groups are
 * left off the messaging surface until their roster/approval semantics are
 * mapped; direct messages use the sender's wxid as the conversation id.
 */
export class WechatAdapter implements Adapter<WechatThreadId, WechatRawMessage> {
  readonly name = "wechat";
  readonly userName = "wechat";

  private readonly apiUrl: string;
  private readonly apiToken: string;
  private readonly webhookSecret: string;
  private readonly http: typeof fetch;
  private chat: ChatInstance | undefined;

  constructor(config: WechatAdapterConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.apiToken = config.apiToken;
    this.webhookSecret = config.webhookSecret;
    this.http = config.fetch ?? fetch;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const provided = request.headers.get(WECHAT_WEBHOOK_SECRET_HEADER) ?? "";
    if (!sameSecret(provided, this.webhookSecret)) {
      return new Response("Invalid secret", { status: 401 });
    }
    if (!this.chat) return new Response("Not initialized", { status: 503 });

    let body: WechatInboundPayload;
    try {
      body = (await request.json()) as WechatInboundPayload;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!body?.message) return new Response("Missing message", { status: 400 });

    const eventId = request.headers.get("X-Lweixin-Event-Id");
    let message: ChatMessage<WechatRawMessage>;
    try {
      message = this.parseMessage({
        ...body.message,
        ...(body.bot_id ? { botId: body.bot_id } : {}),
        ...(eventId ? { eventId } : {}),
      });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "Invalid message", {
        status: 400,
      });
    }

    await this.chat.processMessage(this, message.threadId, message, options);
    return new Response("OK", { status: 200 });
  }

  encodeThreadId(platformData: WechatThreadId): string {
    if (!platformData.conversationId) throw new Error("WeChat conversation id is required");
    return `wechat:${platformData.conversationId}`;
  }

  decodeThreadId(threadId: string): WechatThreadId {
    const prefix = "wechat:";
    const conversationId = threadId.startsWith(prefix) ? threadId.slice(prefix.length) : "";
    if (!conversationId) throw new Error(`Invalid WeChat thread id: ${threadId}`);
    return { conversationId };
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(threadId: string): boolean {
    return !this.decodeThreadId(threadId).conversationId.endsWith("@chatroom");
  }

  async openDM(userId: string): Promise<string> {
    return this.encodeThreadId({ conversationId: userId });
  }

  parseMessage(raw: WechatRawMessage): ChatMessage<WechatRawMessage> {
    const conversationId = raw.from?.trim();
    if (!conversationId) throw new Error("WeChat message has no sender conversation");
    const isGroup = raw.is_group ?? conversationId.endsWith("@chatroom");
    const sender = (isGroup && raw.group_sender?.trim()) || conversationId;
    const text = stripGroupPrefix(raw.content ?? "", raw.group_sender);
    const id =
      raw.eventId ||
      raw.new_msg_id ||
      raw.msg_id ||
      `${conversationId}:${raw.create_time ?? 0}:${raw.seq ?? 0}`;
    return new Message({
      id,
      threadId: this.encodeThreadId({ conversationId }),
      text,
      formatted: parseMarkdown(text),
      raw,
      author: {
        userId: sender,
        userName: sender,
        fullName: sender,
        isBot: false,
        isMe: false,
      },
      metadata: {
        dateSent: raw.create_time ? new Date(raw.create_time * 1000) : new Date(),
        edited: false,
      },
      attachments: [],
    });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<WechatRawMessage>> {
    const { conversationId } = this.decodeThreadId(threadId);
    const content = postableText(message);
    if (!content.trim()) throw new Error("WeChat cannot send an empty message");

    const response = await this.http(`${this.apiUrl}/api/message/send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-token": this.apiToken },
      body: JSON.stringify({ to: conversationId, content }),
      signal: AbortSignal.timeout(WECHAT_SEND_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      data?: { ret?: number; svrid?: string | number };
    } | null;
    if (!response.ok || payload?.ok !== true) {
      const ret = payload?.data?.ret ?? response.status;
      throw new Error(`WeChat send failed (ret=${ret})`);
    }
    const svrid = payload.data?.svrid;
    return {
      id: svrid === undefined ? idForSend(conversationId, content) : String(svrid),
      raw: { from: conversationId, content },
      threadId,
    };
  }

  async editMessage(): Promise<RawMessage<WechatRawMessage>> {
    throw new Error("WeChat cannot edit messages");
  }

  async deleteMessage(): Promise<void> {}

  async addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {}

  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {}

  async startTyping(): Promise<void> {}

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return {
      id: threadId,
      channelId: threadId,
      isDM: this.isDM(threadId),
      metadata: {},
    };
  }

  async fetchMessages(
    _threadId: string,
    _options?: FetchOptions,
  ): Promise<FetchResult<WechatRawMessage>> {
    return { messages: [] };
  }

  renderFormatted(content: FormattedContent): string {
    return toPlainText(content);
  }
}

export function createWechatAdapter(config: WechatAdapterConfig): WechatAdapter {
  return new WechatAdapter(config);
}

function postableText(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  if ("raw" in message) return message.raw;
  if ("markdown" in message) return markdownToPlainText(message.markdown);
  if ("ast" in message) return toPlainText(message.ast);
  return "";
}

function stripGroupPrefix(content: string, groupSender: string | undefined): string {
  if (!groupSender) return content;
  const prefix = `${groupSender}:\n`;
  return content.startsWith(prefix) ? content.slice(prefix.length) : content;
}

function sameSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function idForSend(conversationId: string, content: string): string {
  return `wechat-send:${createHash("sha256")
    .update(`${conversationId}\n${content}`)
    .digest("hex")
    .slice(0, 24)}`;
}
