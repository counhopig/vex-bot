import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus, type VexEvent } from "../src/core/events.js";
import { Session } from "../src/core/session.js";
import { SessionManager, UnknownSessionError, WECHAT_SESSION_KEY, webSessionKey, type SessionManagerOptions } from "../src/core/sessionManager.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";
import { evidence } from "./helpers/evidence.js";

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let busEvents: VexEvent[];

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  busEvents = [];
});
afterEach(async () => {
  await removeTmpDir(dir);
});

function makeManager(generateTitle?: (u: string, a: string) => Promise<string>, extra: Partial<SessionManagerOptions> = {}) {
  const bus = new EventBus();
  bus.on((e) => busEvents.push(e));
  const manager = new SessionManager({
    paths,
    bus,
    generateTitle,
    idleTimeoutMs: 0,
    ...extra,
    openSession: (key, transcriptPath, windowLabel) =>
      Session.open({ evidence,
        key,
        transcriptPath,
        model: faux.getModel(),
        tools: [],
        streamFn: fauxStreamFn(faux),
        getApiKey: () => "k",
        buildSystemPrompt: async () => windowLabel(),
        emit: (event) => bus.emit({ type: "session", sessionKey: key, event }),
      }),
  });
  return manager;
}

describe("SessionManager", () => {
  it("creates web sessions and persists the index", async () => {
    faux = createFaux();
    const manager = makeManager();
    await manager.init();
    const meta = await manager.createWeb();
    expect(meta).toMatchObject({ title: "New chat", titled: false });
    expect(busEvents).toContainEqual({ type: "sessions_changed" });

    const again = makeManager();
    await again.init();
    expect(again.listWeb().map((m) => m.id)).toEqual([meta.id]);
  });

  it("labels windows for the system prompt", async () => {
    faux = createFaux();
    const prompts: string[] = [];
    faux.setResponses([
      (ctx) => { prompts.push(getCurrentSystemPrompt(ctx.messages)); return fauxAssistantMessage("a"); },
      (ctx) => { prompts.push(getCurrentSystemPrompt(ctx.messages)); return fauxAssistantMessage("b"); },
    ]);
    const manager = makeManager();
    await manager.init();
    const meta = await manager.createWeb();
    const web = await manager.get(webSessionKey(meta.id));
    web.send("hi");
    await web.whenIdle();
    const wechat = await manager.get(WECHAT_SESSION_KEY);
    wechat.send("hi");
    await wechat.whenIdle();
    expect(prompts).toEqual(['WebChat conversation "New chat"', "WeChat"]);
    expect((await stat(join(paths.sessions, "wechat.jsonl"))).isFile()).toBe(true);
  });

  it("returns the same session instance for the same key", async () => {
    faux = createFaux();
    const manager = makeManager();
    await manager.init();
    const [a, b] = await Promise.all([manager.get(WECHAT_SESSION_KEY), manager.get(WECHAT_SESSION_KEY)]);
    expect(a).toBe(b);
  });

  it("titles a web session after its first reply", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("推荐耶加雪菲"), fauxAssistantMessage("不客气")]);
    const generateTitle = vi.fn(async (_user: string, _assistant: string) => "咖啡推荐");
    const manager = makeManager(generateTitle);
    await manager.init();
    const meta = await manager.createWeb();
    const session = await manager.get(webSessionKey(meta.id));
    session.send("推荐咖啡");
    await session.whenIdle();
    await vi.waitFor(() => expect(manager.listWeb()[0]).toMatchObject({ title: "咖啡推荐", titled: true }));
    session.send("谢谢");
    await session.whenIdle();
    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(generateTitle).toHaveBeenCalledWith("推荐咖啡", "推荐耶加雪菲");
  });

  it("does not auto-title a renamed session", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("x")]);
    const generateTitle = vi.fn(async (_user: string, _assistant: string) => "自动");
    const manager = makeManager(generateTitle);
    await manager.init();
    const meta = await manager.createWeb();
    await manager.renameWeb(meta.id, "  我的标题  ");
    const session = await manager.get(webSessionKey(meta.id));
    session.send("hi");
    await session.whenIdle();
    expect(generateTitle).not.toHaveBeenCalled();
    expect(manager.listWeb()[0]?.title).toBe("我的标题");
    expect(manager.windowLabel(webSessionKey(meta.id))).toBe('WebChat conversation "我的标题"');
  });

  it("orders sessions by latest activity", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("x")]);
    const manager = makeManager();
    await manager.init();
    const older = await manager.createWeb();
    await new Promise((r) => setTimeout(r, 5));
    const newer = await manager.createWeb();
    expect(manager.listWeb().map((m) => m.id)).toEqual([newer.id, older.id]);
    await new Promise((r) => setTimeout(r, 5));
    const session = await manager.get(webSessionKey(older.id));
    session.send("hi");
    await session.whenIdle();
    await vi.waitFor(() => expect(manager.listWeb().map((m) => m.id)).toEqual([older.id, newer.id]));
  });

  it("deletes a session with its transcript", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("x")]);
    const manager = makeManager();
    await manager.init();
    const meta = await manager.createWeb();
    const session = await manager.get(webSessionKey(meta.id));
    session.send("hi");
    await session.whenIdle();
    await manager.deleteWeb(meta.id);
    expect(manager.listWeb()).toEqual([]);
    await expect(stat(join(paths.webSessions, `${meta.id}.jsonl`))).rejects.toThrow();
    await expect(manager.get(webSessionKey(meta.id))).rejects.toThrow(UnknownSessionError);
    await expect(manager.deleteWeb(meta.id)).rejects.toThrow(UnknownSessionError);
  });

  it("allows retrying after session disposal fails during deletion", async () => {
    faux = createFaux();
    const manager = makeManager();
    await manager.init();
    const meta = await manager.createWeb();
    const key = webSessionKey(meta.id);
    const session = await manager.get(key);
    const dispose = vi.spyOn(session, "dispose").mockRejectedValueOnce(new Error("dispose failed"));

    await expect(manager.deleteWeb(meta.id)).rejects.toThrow("dispose failed");
    expect(await manager.get(key)).toBe(session);

    dispose.mockRestore();
    await expect(manager.deleteWeb(meta.id)).resolves.toBeUndefined();
    await expect(manager.get(key)).rejects.toThrow(UnknownSessionError);
  });

  it("rejects get and send lookups as soon as deletion starts", async () => {
    faux = createFaux();
    const manager = makeManager();
    await manager.init();
    const meta = await manager.createWeb();
    const key = webSessionKey(meta.id);
    const session = await manager.get(key);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispose = vi.spyOn(session, "dispose").mockImplementation(async () => gate);
    const deletion = manager.deleteWeb(meta.id);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    await expect(manager.get(key)).rejects.toThrow(UnknownSessionError);
    const send = vi.spyOn(session, "send");
    await expect(manager.get(key).then((s) => s.send("late"))).rejects.toThrow(UnknownSessionError);
    expect(send).not.toHaveBeenCalled();
    release();
    await deletion;
    await expect(manager.get(key)).rejects.toThrow(UnknownSessionError);
    expect(manager.listWeb()).toEqual([]);
    await expect(stat(join(paths.webSessions, `${meta.id}.jsonl`))).rejects.toThrow();
  });

  it("rejects an in-flight open and disposes it when deletion begins", async () => {
    faux = createFaux();
    const manager = makeManager();
    await manager.init();
    const meta = await manager.createWeb();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalOpen = Session.open;
    let opened: Session | undefined;
    const spy = vi.spyOn(Session, "open").mockImplementationOnce(async (opts) => {
      await gate;
      opened = await originalOpen(opts);
      vi.spyOn(opened, "dispose");
      return opened;
    });
    try {
      const pending = manager.get(webSessionKey(meta.id));
      const rejected = expect(pending).rejects.toThrow(UnknownSessionError);
      const deletion = manager.deleteWeb(meta.id);
      await expect(manager.get(webSessionKey(meta.id))).rejects.toThrow(UnknownSessionError);
      release();
      await rejected;
      await deletion;
      expect(opened?.dispose).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledOnce();
      expect(manager.listWeb()).toEqual([]);
      await expect(manager.get(webSessionKey(meta.id))).rejects.toThrow(UnknownSessionError);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("rejects a send if deletion starts after get resolves but before the caller resumes", async () => {
    faux = createFaux();
    const manager = makeManager();
    await manager.init();
    const meta = await manager.createWeb();
    const key = webSessionKey(meta.id);
    const session = await manager.get(key);
    const send = vi.spyOn(session, "send");
    const pending = manager.get(key).then((loaded) => {
      manager.assertAvailable(key);
      loaded.send("late");
    });
    let deletion!: Promise<void>;
    queueMicrotask(() => { deletion = manager.deleteWeb(meta.id); });
    await expect(pending).rejects.toThrow(UnknownSessionError);
    await deletion;
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects unknown keys", async () => {
    faux = createFaux();
    const manager = makeManager();
    await manager.init();
    await expect(manager.get("web:nope")).rejects.toThrow(UnknownSessionError);
    await expect(manager.get("../etc")).rejects.toThrow(UnknownSessionError);
  });

  it("rebuilds a corrupt index from transcripts", async () => {
    faux = createFaux();
    await mkdir(paths.webSessions, { recursive: true });
    await writeFile(join(paths.webSessions, "abc.jsonl"), "", "utf8");
    await writeFile(join(paths.webSessions, "index.json"), "{not json", "utf8");
    const manager = makeManager();
    await manager.init();
    expect(manager.listWeb()).toEqual([expect.objectContaining({ id: "abc", title: "Untitled chat", titled: true })]);
    expect(JSON.parse(await readFile(join(paths.webSessions, "index.json"), "utf8"))).toHaveLength(1);
  });

  it("stops running sessions on shutdown", async () => {
    faux = createFaux(20);
    faux.setResponses([fauxAssistantMessage("long ".repeat(80))]);
    const manager = makeManager();
    await manager.init();
    const session = await manager.get(WECHAT_SESSION_KEY);
    session.send("go");
    await new Promise((r) => setTimeout(r, 100));
    await manager.shutdown();
    expect(session.busy).toBe(false);
    expect(session.history().items.at(-1)).toMatchObject({ kind: "assistant", stopReason: "aborted" });
  });

  it("refuses to open sessions once shutdown has begun", async () => {
    faux = createFaux();
    const manager = makeManager();
    await manager.init();
    const opened = manager.shutdown();
    await expect(manager.get(WECHAT_SESSION_KEY)).rejects.toThrow("vexd is shutting down");
    await opened;
    await expect(manager.get(WECHAT_SESSION_KEY)).rejects.toThrow("vexd is shutting down");
  });
});

describe("SessionManager idle eviction", () => {
  const IDLE = 60_000;
  let now: number;
  const managerWithClock = (retain?: (key: string) => boolean) => makeManager(undefined, { idleTimeoutMs: IDLE, now: () => now, ...(retain ? { retain } : {}) });
  beforeEach(() => { now = Date.parse("2026-10-11T10:00:00Z"); });

  async function chatOnce(manager: SessionManager, text: string): Promise<{ key: string; session: Session }> {
    const meta = await manager.createWeb();
    const key = webSessionKey(meta.id);
    const session = await manager.get(key);
    session.send(text);
    await session.whenIdle();
    return { key, session };
  }

  it("disposes an idle WebChat session and restores the same history from its transcript", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
    const manager = managerWithClock();
    await manager.init();
    const { key, session } = await chatOnce(manager, "first question");
    const dispose = vi.spyOn(session, "dispose");
    const before = session.history().items;

    now += IDLE - 1;
    expect(await manager.evictIdle()).toEqual([]);
    now += 1;
    expect(await manager.evictIdle()).toEqual([key]);
    expect(dispose).toHaveBeenCalledOnce();

    const restored = await manager.get(key);
    expect(restored).not.toBe(session);
    expect(restored.history().items).toEqual(before);
    restored.send("second question");
    await restored.whenIdle();
    expect(restored.history().items.map((item) => item.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    const lines = (await readFile(join(paths.webSessions, `${key.slice(4)}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { role?: string });
    expect(lines.filter((line) => line.role === "user")).toHaveLength(2);
    await manager.shutdown();
  });

  it("keeps WeChat, running, recently used and retained sessions", async () => {
    faux = createFaux();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    faux.setResponses([fauxAssistantMessage("done"), async () => { await gate; return fauxAssistantMessage("slow"); }, fauxAssistantMessage("wechat")]);
    let retained = "";
    const manager = managerWithClock((key) => key === retained);
    await manager.init();
    const held = await chatOnce(manager, "keep me");
    retained = held.key;
    const running = await manager.createWeb();
    const runningKey = webSessionKey(running.id);
    (await manager.get(runningKey)).send("long task");
    const wechat = await manager.get(WECHAT_SESSION_KEY);
    wechat.send("hi");
    const recent = await manager.createWeb();
    now += IDLE;
    await manager.get(webSessionKey(recent.id));

    expect(await manager.evictIdle()).toEqual([]);
    retained = "";
    expect(await manager.evictIdle()).toEqual([held.key]);
    release();
    await (await manager.get(runningKey)).whenIdle();
    await wechat.whenIdle();
    now += IDLE;
    expect((await manager.evictIdle()).sort()).toEqual([runningKey, webSessionKey(recent.id)].sort());
    expect(await manager.get(WECHAT_SESSION_KEY)).toBe(wechat);
    await manager.shutdown();
  });

  it("makes requests during eviction wait for the flushed transcript and share one fresh instance", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("reply")]);
    const manager = managerWithClock();
    await manager.init();
    const { key, session } = await chatOnce(manager, "question");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispose = session.dispose.bind(session);
    vi.spyOn(session, "dispose").mockImplementation(async () => { await gate; await dispose(); order.push("disposed"); });
    const open = vi.spyOn(Session, "open");

    now += IDLE;
    const eviction = manager.evictIdle();
    const first = manager.get(key);
    const second = manager.get(key);
    await new Promise((resolve) => setImmediate(resolve));
    expect(open).not.toHaveBeenCalled();
    release();
    const [a, b] = await Promise.all([first, second]);
    order.push("opened");
    await eviction;
    expect(a).toBe(b);
    expect(a).not.toBe(session);
    expect(open).toHaveBeenCalledOnce();
    expect(order).toEqual(["disposed", "opened"]);
    expect(a.history().items).toEqual(session.history().items);
    open.mockRestore();
    await manager.shutdown();
  });

  it("never hands out an instance that started disposing after its lookup began", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("reply")]);
    const manager = managerWithClock();
    await manager.init();
    const { key, session } = await chatOnce(manager, "question");
    now += IDLE;
    const lookup = manager.get(key);
    now += IDLE;
    await manager.evictIdle();
    const loaded = await lookup;
    expect(loaded).not.toBe(session);
    expect(loaded.history().items).toEqual(session.history().items);
    await manager.shutdown();
  });

  it("deletes a conversation only after its evicted instance has finished writing", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("reply")]);
    const manager = managerWithClock();
    await manager.init();
    const { key, session } = await chatOnce(manager, "question");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispose = session.dispose.bind(session);
    let disposed = false;
    vi.spyOn(session, "dispose").mockImplementation(async () => { await gate; await dispose(); disposed = true; });
    now += IDLE;
    const eviction = manager.evictIdle();
    const deletion = manager.deleteWeb(key.slice(4));
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.listWeb()).toHaveLength(1);
    release();
    await deletion;
    await eviction;
    expect(disposed).toBe(true);
    await expect(stat(join(paths.webSessions, `${key.slice(4)}.jsonl`))).rejects.toThrow();
    await expect(manager.get(key)).rejects.toThrow(UnknownSessionError);
    await manager.shutdown();
  });

  it("waits for an eviction in progress on shutdown", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("reply")]);
    const manager = managerWithClock();
    await manager.init();
    const { session } = await chatOnce(manager, "question");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispose = session.dispose.bind(session);
    let disposed = false;
    vi.spyOn(session, "dispose").mockImplementation(async () => { await gate; await dispose(); disposed = true; });
    now += IDLE;
    void manager.evictIdle();
    const shutdown = manager.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);
    release();
    await shutdown;
    expect(disposed).toBe(true);
  });
});
