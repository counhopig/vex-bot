import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeChatChannel, type WeChatChannelOptions } from "../src/channels/wechat/channel.js";
import { WeChatClient } from "../src/channels/wechat/client.js";
import { WeChatStore } from "../src/channels/wechat/store.js";
import { EventBus, type SessionEvent } from "../src/core/events.js";
import { ApprovalManager } from "../src/policy/approvals.js";
import { FakeIlink, textMessage } from "./helpers/ilink.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

class FakeSession {
  busy = false;
  readonly sent: string[] = [];
  stops = 0;
  send(text: string): void {
    this.sent.push(text);
  }
  stop(): void {
    this.stops++;
  }
}

let ilink: FakeIlink;
let dir: string;
let store: WeChatStore;
let bus: EventBus;
let approvals: ApprovalManager;
let session: FakeSession;
let keys: string[];
let channel: WeChatChannel | undefined;

beforeEach(async () => {
  ilink = new FakeIlink();
  await ilink.start();
  dir = await makeTmpDir();
  store = new WeChatStore(join(dir, "wechat"));
  bus = new EventBus();
  approvals = new ApprovalManager({ onChange: () => bus.emit({ type: "approvals_changed" }) });
  session = new FakeSession();
  keys = [];
});
afterEach(async () => {
  await channel?.stop();
  channel = undefined;
  approvals.dispose();
  await ilink.stop();
  await removeTmpDir(dir);
});

async function startChannel(overrides: Partial<WeChatChannelOptions> = {}): Promise<WeChatChannel> {
  channel = new WeChatChannel({
    client: new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" }),
    store,
    ownerId: "owner1",
    sessions: {
      get: async (key) => {
        keys.push(key);
        return session;
      },
    },
    approvals,
    bus,
    log: pino({ level: "silent" }),
    idleDelayMs: 5,
    initialBackoffMs: 5,
    processingNoticeMs: 40,
    timeZone: "Asia/Shanghai",
    ...overrides,
  });
  await channel.start();
  return channel;
}

function emit(event: SessionEvent): void {
  bus.emit({ type: "session", sessionKey: "wechat", event });
}

async function sentTexts(): Promise<string[]> {
  await channel?.drained();
  return ilink.sentTexts();
}

describe("WeChatChannel inbound", () => {
  it("passes owner messages to the wechat session and ignores everyone else", async () => {
    ilink.queueUpdates(
      textMessage("owner1", "你好", { message_id: "m1" }),
      textMessage("stranger", "hi", { message_id: "m2" }),
      textMessage("owner1", "你好", { message_id: "m1" }),
    );
    ilink.queueUpdates(textMessage("owner1", "第二句", { message_id: "m3" }));
    await startChannel();
    await vi.waitFor(() => expect(session.sent).toEqual(["你好", "第二句"]));
    expect(keys.every((k) => k === "wechat")).toBe(true);
    expect(await store.loadState()).toEqual({ contextToken: "ctx-owner1" });
  });

  it("stops a running turn on /stop and says so when idle", async () => {
    ilink.queueUpdates(textMessage("owner1", "/stop", { message_id: "s1" }));
    session.busy = true;
    await startChannel();
    await vi.waitFor(() => expect(session.stops).toBe(1));
    session.busy = false;
    ilink.queueUpdates(textMessage("owner1", "／stop", { message_id: "s2" }));
    await vi.waitFor(async () => expect(await sentTexts()).toEqual(["现在没有在运行的任务。"]));
    expect(session.stops).toBe(1);
    expect(session.sent).toEqual([]);
  });
});

describe("WeChatChannel outbound", () => {
  it("sends one reply per turn using the saved context token", async () => {
    await store.saveState({ contextToken: "ctx-saved" });
    await startChannel({ processingNoticeMs: 60_000 });
    emit({ kind: "busy", busy: true });
    emit({ kind: "assistant_message", text: "第一段", stopReason: "toolUse", timestamp: 1 });
    emit({ kind: "assistant_message", text: "第二段", stopReason: "stop", timestamp: 2 });
    emit({ kind: "busy", busy: false });
    expect(await sentTexts()).toEqual(["第一段\n\n第二段"]);
    const body = ilink.requests.find((r) => r.path === "/ilink/bot/sendmessage")?.body as { msg: Record<string, unknown> };
    expect(body.msg).toMatchObject({ to_user_id: "owner1", context_token: "ctx-saved" });
  });

  it("tells the owner a long turn is still running", async () => {
    await store.saveState({ contextToken: "ctx" });
    await startChannel({ processingNoticeMs: 30 });
    emit({ kind: "busy", busy: true });
    await vi.waitFor(async () => expect(await sentTexts()).toEqual(["处理中…"]));
    emit({ kind: "assistant_message", text: "好了", stopReason: "stop", timestamp: 1 });
    emit({ kind: "busy", busy: false });
    expect(await sentTexts()).toEqual(["处理中…", "好了"]);
  });

  it("marks interrupted turns and reports errors", async () => {
    await store.saveState({ contextToken: "ctx" });
    await startChannel({ processingNoticeMs: 60_000 });
    emit({ kind: "busy", busy: true });
    emit({ kind: "assistant_message", text: "写到一半", stopReason: "aborted", timestamp: 1 });
    emit({ kind: "busy", busy: false });
    emit({ kind: "busy", busy: true });
    emit({ kind: "assistant_message", text: "", stopReason: "aborted", timestamp: 2 });
    emit({ kind: "busy", busy: false });
    emit({ kind: "busy", busy: true });
    emit({ kind: "error", message: "模型调用失败：boom" });
    emit({ kind: "busy", busy: false });
    expect(await sentTexts()).toEqual(["写到一半\n（已中断）", "已中断。", "模型调用失败：boom"]);
  });

  it("splits long replies", async () => {
    await store.saveState({ contextToken: "ctx" });
    await startChannel({ processingNoticeMs: 60_000 });
    emit({ kind: "busy", busy: true });
    emit({ kind: "assistant_message", text: "字".repeat(4500), stopReason: "stop", timestamp: 1 });
    emit({ kind: "busy", busy: false });
    expect((await sentTexts()).map((t) => t.length)).toEqual([2000, 2000, 500]);
  });

  it("drops outgoing messages until the owner has written once", async () => {
    await startChannel({ processingNoticeMs: 60_000 });
    emit({ kind: "busy", busy: true });
    emit({ kind: "assistant_message", text: "没人收", stopReason: "stop", timestamp: 1 });
    emit({ kind: "busy", busy: false });
    expect(await sentTexts()).toEqual([]);
  });
});

describe("WeChatChannel approvals", () => {
  it("announces pending approvals and answers the oldest one", async () => {
    await store.saveState({ contextToken: "ctx" });
    await startChannel();
    const first = approvals.request({ sessionKey: "web:1", windowLabel: "网页会话「A」", toolName: "bash", args: { command: "ls" } });
    const second = approvals.request({ sessionKey: "wechat", windowLabel: "微信", toolName: "write", args: { path: "/etc/x" } });
    await vi.waitFor(async () => expect(await sentTexts()).toHaveLength(2));
    const [promptA, promptB] = await sentTexts();
    expect(promptA).toContain("【需要你批准】网页会话「A」想执行 bash：\nls");
    expect(promptB).toContain("（共有 2 条待批准，按先后顺序处理）");

    ilink.queueUpdates(textMessage("owner1", "/y", { message_id: "a1" }));
    await expect(first).resolves.toEqual({ allowed: true });
    ilink.queueUpdates(textMessage("owner1", "/n", { message_id: "a2" }));
    await expect(second).resolves.toMatchObject({ allowed: false });
    ilink.queueUpdates(textMessage("owner1", "/ya", { message_id: "a3" }));
    await vi.waitFor(async () => expect((await sentTexts()).slice(2)).toEqual(["已允许：bash", "已拒绝：write", "没有待批准的请求。"]));
    expect(session.sent).toEqual([]);
  });

  it("remembers allow_session from /ya", async () => {
    await store.saveState({ contextToken: "ctx" });
    await startChannel();
    const pending = approvals.request({ sessionKey: "wechat", windowLabel: "微信", toolName: "bash", args: { command: "pwd" } });
    ilink.queueUpdates(textMessage("owner1", "/ya", { message_id: "b1" }));
    await expect(pending).resolves.toEqual({ allowed: true });
    expect(approvals.isSessionAllowed("wechat", "bash")).toBe(true);
    await vi.waitFor(async () => expect(await sentTexts()).toContain("已允许，本会话之后不再询问 bash"));
  });
});

describe("WeChatChannel polling", () => {
  it("recovers from a transient failure", async () => {
    const responses: unknown[] = [502, { ret: 0, msgs: [textMessage("owner1", "恢复了", { message_id: "r1" })] }];
    ilink.on("/ilink/bot/getupdates", () => responses.shift() ?? { ret: 0, msgs: [] });
    await startChannel();
    await vi.waitFor(() => expect(session.sent).toEqual(["恢复了"]));
    expect(channel?.expired).toBe(false);
  });

  it("stops polling when the login has expired", async () => {
    ilink.on("/ilink/bot/getupdates", () => ({ ret: 0, errcode: -14, errmsg: "session timeout" }));
    await startChannel();
    await vi.waitFor(() => expect(channel?.expired).toBe(true));
    const count = ilink.requests.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(ilink.requests.length).toBe(count);
  });

  it("stops promptly while a long poll is in flight", async () => {
    ilink.on("/ilink/bot/getupdates", () => new Promise(() => {}));
    await startChannel();
    await vi.waitFor(() => expect(ilink.requests.length).toBe(1));
    const started = Date.now();
    await channel?.stop();
    channel = undefined;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
