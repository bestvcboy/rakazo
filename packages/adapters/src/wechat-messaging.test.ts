import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import {
  createWechatAdapter,
  WECHAT_WEBHOOK_SECRET_HEADER,
} from "./wechat/wechat-adapter.js";

const context: AdapterContext = {
  operationId: "op-test",
  traceId: "trace-test",
  spaceId: "space-test",
  userId: "user-test",
  signal: new AbortController().signal,
};

function createSurface(fetchImpl: typeof fetch = vi.fn()) {
  const adapter = createWechatAdapter({
    apiUrl: "https://lweixin.test/",
    apiToken: "api-token",
    webhookSecret: "hook-secret",
    fetch: fetchImpl,
  });
  const surface = new ChatSdkMessagingSurface([
    { provider: "wechat", capabilities: { direct: true, groups: false, receipt: null }, adapter },
  ]);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  return { adapter, surface, events };
}

function webhook(body: unknown, secret = "hook-secret") {
  return new Request("https://rakazo.test/api/v1/messaging/webhook/wechat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [WECHAT_WEBHOOK_SECRET_HEADER]: secret,
      "X-Lweixin-Event-Id": "lweixin:src:acct:7",
    },
    body: JSON.stringify(body),
  });
}

describe("WeChat messaging", () => {
  it("delivers a lweixin direct message as a DM with the event id as handle", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook(
      "wechat",
      webhook({
        bot_id: "wxid_bot",
        message: {
          type: 1,
          content: "hello",
          create_time: 1_700_000_000,
          from: "wxid_alice",
          seq: 7,
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "wechat",
      handle: "lweixin:src:acct:7",
      threadId: "wechat:wxid_alice",
      isDirect: true,
      from: "wxid_alice",
      content: "hello",
    });
  });

  it("rejects a webhook with the wrong secret", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook(
      "wechat",
      webhook({ message: { from: "wxid_alice", content: "hello" } }, "wrong"),
    );
    expect(response?.status).toBe(401);
    expect(events).toEqual([]);
  });

  it("sends replies through lweixin with its API token", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
      calls.push({ input, init });
      return Response.json({ ok: true, data: { ret: 0, svrid: "42" } });
    }) as unknown as typeof fetch;
    const { adapter, surface } = createSurface(fetchImpl);

    const sent = await surface.sendToThread(
      { threadId: adapter.encodeThreadId({ conversationId: "wxid_alice" }), body: "hi" },
      context,
    );

    expect(sent.handle).toBe("42");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe("https://lweixin.test/api/message/send");
    expect(calls[0]!.init.headers).toMatchObject({ "x-api-token": "api-token" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ to: "wxid_alice", content: "hi" });
  });

  it("uses the group sender as author but keeps the chatroom thread", () => {
    const { adapter } = createSurface();
    const message = adapter.parseMessage({
      from: "123@chatroom",
      is_group: true,
      group_sender: "wxid_alice",
      content: "wxid_alice:\nhello room",
    });
    expect(message.threadId).toBe("wechat:123@chatroom");
    expect(message.author.userId).toBe("wxid_alice");
    expect(message.text).toBe("hello room");
    expect(adapter.isDM(message.threadId)).toBe(false);
  });
});
