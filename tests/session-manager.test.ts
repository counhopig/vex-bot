import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus, type VexEvent } from "../src/core/events.js";
import { Session } from "../src/core/session.js";
import { SessionManager, UnknownSessionError, WECHAT_SESSION_KEY, webSessionKey } from "../src/core/sessionManager.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

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

function makeManager(generateTitle?: (u: string, a: string) => Promise<string>) {
  const bus = new EventBus();
  bus.on((e) => busEvents.push(e));
  const manager = new SessionManager({
    paths,
    bus,
    generateTitle,
    openSession: (key, transcriptPath, windowLabel) =>
      Session.open({
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
    expect(meta).toMatchObject({ title: "新对话", titled: false });
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
    expect(prompts).toEqual(["网页会话「新对话」", "微信"]);
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
    expect(manager.windowLabel(webSessionKey(meta.id))).toBe("网页会话「我的标题」");
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
    expect(manager.listWeb()).toEqual([expect.objectContaining({ id: "abc", title: "未命名对话", titled: true })]);
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
    await expect(manager.get(WECHAT_SESSION_KEY)).rejects.toThrow("vexd 正在关闭");
    await opened;
    await expect(manager.get(WECHAT_SESSION_KEY)).rejects.toThrow("vexd 正在关闭");
  });
});
