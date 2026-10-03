import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = "";
  textContent = "";
  value = "";
  checked = false;
  hidden = false;
  id = "";
  href = "";
  style: Record<string, string> = {};
  scrollHeight = 0;
  scrollTop = 0;
  private listeners = new Map<string, ((event: object) => void)[]>();

  constructor(readonly tagName = "div") {}
  get firstChild() { return this.children[0]; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  remove() {}
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(type: string, listener: (event: object) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} });
  }
}

function find(root: Element, test: (el: Element) => boolean): Element | undefined {
  if (test(root)) return root;
  for (const child of root.children) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return undefined;
}

function textOf(el: Element): string {
  return el.textContent + el.children.map(textOf).join("");
}

async function loadApp() {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    addEventListener = vi.fn();
  }
  const prompt = vi.fn(() => "新标题");
  const stored = new Map<string, string>();
  const documentElement = { dataset: {} as Record<string, string> };
  const context = createContext({
    document: { getElementById: get, createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => Object.assign(new Element("#text"), { textContent: text }), documentElement, hidden: false },
    WebSocket: Socket,
    location: { protocol: "http:", host: "localhost" },
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } },
    setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(), prompt,
  });
  runInContext(await readFile(new URL("../src/web/static/app.js", import.meta.url), "utf8"), context);
  runInContext('handle({ type: "sessions", sessions: [{ id: "one", title: "一" }, { id: "two", title: "二" }] })', context);
  const socket = runInContext("state.ws", context) as Socket;
  const call = (code: string) => JSON.parse(JSON.stringify(runInContext(code, context)));
  return { get, context, socket, prompt, documentElement, stored, call };
}

describe("web app", () => {
  it("keeps a title node attached through both clicks of a rename", async () => {
    const { get, socket, prompt } = await loadApp();
    const row = get("session-list").children[1]!;
    const title = row.children[0]!;
    title.dispatch("click");
    expect(get("session-list").children[1]).toBe(row);
    expect(row.className).toBe("active");
    title.dispatch("click");
    title.dispatch("dblclick");
    expect(prompt).toHaveBeenCalledWith("会话名称", "二");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "rename_session", sessionId: "two", title: "新标题" }));
  });

  it.each(["closed", "throw"])("preserves input when sending over a %s connection", async (failure) => {
    const { get, socket } = await loadApp();
    if (failure === "closed") socket.readyState = 3;
    else socket.send.mockImplementation(() => { throw new Error("connection closed"); });
    get("input").value = "  未发送的文本  ";
    get("composer").dispatch("submit");
    expect(get("input").value).toBe("  未发送的文本  ");
    expect(get("status").textContent).toBe("连接已断开，正在重连…");
    expect(get("status").hidden).toBe(false);
  });

  const settingsMessage = (values: Record<string, unknown>, secrets: string[] = []) => JSON.stringify({
    type: "settings", values, secrets, catalog: { providers: ["deepseek", "minimax-cn"], models: { deepseek: ["deepseek-v4-pro"] } },
  });

  it("saves only the form fields that changed and keeps untouched secrets", async () => {
    const { get, socket, context } = await loadApp();
    get("open-settings").dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "get_settings" }));
    runInContext(`handle(${settingsMessage({ "model.provider": "deepseek", "model.id": "deepseek-v4-pro" }, ["providers.deepseek.apiKey"])})`, context);
    const form = get("settings-form");
    const model = find(form, (el) => el.id === "f-model-id")!;
    model.value = "deepseek-flash";
    model.dispatch("input");
    const key = find(form, (el) => el.id === "f-key-model-provider")!;
    expect(key.attributes.placeholder ?? key).toBeDefined();
    get("save-settings").dispatch("click");
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: "save_settings", set: { "model.id": "deepseek-flash" }, unset: [] });
    runInContext('handle({ type: "settings_saved", ok: true, restartRequired: true })', context);
    expect(get("settings-result").textContent).toBe("已保存，重启 vexd 后生效");
    runInContext('handle({ type: "settings_saved", ok: true, restartRequired: false })', context);
    expect(get("settings-result").textContent).toBe("已保存，立即生效");
    runInContext('handle({ type: "settings_saved", ok: false, error: "model 无效" })', context);
    expect(get("settings-result").textContent).toBe("model 无效");
    expect(get("settings-result").className).toBe("bad");
  });

  it("sends typed secrets, clears saved ones and skips a save with no changes", async () => {
    const { get, socket, context, call } = await loadApp();
    get("open-settings").dispatch("click");
    runInContext(`handle(${settingsMessage({ "model.provider": "deepseek", "model.id": "x", "stt.baseUrl": "https://s/v1", "stt.model": "w" }, ["providers.deepseek.apiKey", "stt.apiKey"])})`, context);
    const sends = socket.send.mock.calls.length;
    get("save-settings").dispatch("click");
    expect(socket.send.mock.calls.length).toBe(sends);
    expect(get("settings-result").textContent).toBe("没有改动");
    get("settings-tabs").children[2]!.dispatch("click");
    const form = get("settings-form");
    const key = find(form, (el) => el.id === "f-stt-apiKey")!;
    key.value = "new-key";
    key.dispatch("input");
    const clear = find(form, (el) => el.tagName === "input" && el.children.length === 0 && (el as never as { type?: string }).type === "checkbox")!;
    expect(clear).toBeDefined();
    get("save-settings").dispatch("click");
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: "save_settings", set: { "stt.apiKey": "new-key" }, unset: [] });
    expect(call("buildPatch(state.settings)")).toEqual({ set: { "stt.apiKey": "new-key" }, unset: [] });
  });

  it("builds patches for cleared values, paired times and the shared background model", async () => {
    const { context, call } = await loadApp();
    runInContext(`handle(${settingsMessage({ "model.provider": "deepseek", "model.id": "a", "backgroundModel.provider": "deepseek", "backgroundModel.id": "b", "heartbeat.every": "30m", "persona.sleep": ["23:00", "07:00"] }, ["links.bilibili.sessdata"])})`, context);
    runInContext(`const d = state.settings.draft; d["background.same"] = true; d["heartbeat.every"] = ""; d["persona.sleep"] = ["22:00", "06:00"]; state.settings.cleared.add("links.bilibili.sessdata");`, context);
    const patch = call("buildPatch(state.settings)");
    expect(patch.set).toEqual({ "persona.sleep": ["22:00", "06:00"] });
    expect(patch.unset.sort()).toEqual(["backgroundModel.id", "backgroundModel.provider", "heartbeat.every", "links.bilibili.sessdata"]);
  });

  it("switches between the persona files and the raw configuration", async () => {
    const { get, socket, context } = await loadApp();
    get("open-settings").dispatch("click");
    get("settings-tabs").children[4]!.dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "get_file", name: "SOUL.md" }));
    runInContext('handle({ type: "file", name: "USER.md", text: "过期的回复" })', context);
    expect(get("settings-text").value).toBe("");
    runInContext('handle({ type: "file", name: "SOUL.md", text: "你是一只猫" })', context);
    expect(get("settings-text").value).toBe("你是一只猫");
    get("file-tabs").children[1]!.dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "get_file", name: "USER.md" }));
    get("settings-text").value = "喜欢咖啡";
    get("save-settings").dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "save_file", name: "USER.md", text: "喜欢咖啡" }));
    runInContext('handle({ type: "file_saved", name: "USER.md", ok: true })', context);
    expect(get("settings-result").textContent).toBe("已保存，下一条消息起生效");
    get("settings-tabs").children[5]!.dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "get_config" }));
    runInContext('handle({ type: "config", text: "model: {}" })', context);
    expect(get("settings-text").value).toBe("model: {}");
    get("save-settings").dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "save_config", text: "model: {}" }));
  });

  it("parses Markdown blocks and inline spans", async () => {
    const { call } = await loadApp();
    const blocks = call(String.raw`parseMarkdown("# 标题\n\n段落 **粗** 和 \`码\` 与 [链接](https://a.example/x)\n\n- 一\n  - 嵌套\n- 二\n\n1. 甲\n2. 乙\n\n> 引用\n\n---\n\n\`\`\`js\nlet a = 1;\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |")`);
    expect(blocks.map((block: { type: string }) => block.type)).toEqual(["heading", "paragraph", "list", "list", "quote", "rule", "code", "table"]);
    expect(blocks[2].items[0].blocks[0].items[0].inline[0].v).toBe("嵌套");
    expect(blocks[3].ordered).toBe(true);
    expect(blocks[6]).toEqual({ type: "code", lang: "js", text: "let a = 1;" });
    expect(blocks[7].rows[0].map((cell: { v: string }[]) => cell[0]!.v)).toEqual(["1", "2"]);
    const inline = blocks[1].inline.map((node: { t: string }) => node.t);
    expect(inline).toEqual(["text", "bold", "text", "code", "text", "link"]);
    expect(call('parseInline("见 https://b.example/p。")')).toEqual([{ t: "text", v: "见 " }, { t: "link", href: "https://b.example/p", c: [{ t: "text", v: "https://b.example/p" }] }, { t: "text", v: "。" }]);
  });

  it("renders Markdown with DOM nodes only and refuses script links", async () => {
    const { get, context } = await loadApp();
    runInContext(`const box = document.createElement("div"); renderMarkdown(box, ${JSON.stringify("<script>alert(1)</script> [坏](javascript:alert(1)) [好](https://ok.example) `行内` **粗**")}); state.box = box;`, context);
    const box = runInContext("state.box", context) as Element;
    const tags: string[] = [];
    const walk = (el: Element) => { tags.push(el.tagName); el.children.forEach(walk); };
    walk(box);
    expect(tags).toEqual(expect.arrayContaining(["p", "a", "code", "strong"]));
    expect(tags).not.toContain("script");
    const links = [] as Element[];
    const collect = (el: Element) => { if (el.tagName === "a") links.push(el); el.children.forEach(collect); };
    collect(box);
    expect(links.map((el) => el.href)).toEqual(["https://ok.example"]);
    expect(links[0]!.attributes).toBeDefined();
    expect(textOf(box)).toContain("<script>alert(1)</script>");
    expect(textOf(box)).toContain("[坏](javascript:alert(1))");
    expect(get("messages")).toBeDefined();
  });

  it("renders assistant replies as Markdown and keeps user text plain", async () => {
    const { get, context } = await loadApp();
    runInContext('applyEvent({ kind: "user_message", text: "**不渲染**" }); applyEvent({ kind: "assistant_message", text: "**渲染**", stopReason: "stop" })', context);
    const [user, assistant] = get("messages").children;
    expect(user!.children[0]!.textContent).toBe("**不渲染**");
    expect(find(assistant!, (el) => el.tagName === "strong")).toBeDefined();
  });

  it("shows the model, WeChat state and mood in the status line", async () => {
    const { get, context } = await loadApp();
    runInContext('handle({ type: "status", status: { model: "deepseek/v4", wechat: "connected", persona: { energy: 80, mood: 70, social: 50, resting: true } } })', context);
    const line = textOf(get("statusline"));
    expect(line).toContain("deepseek/v4");
    expect(line).toContain("微信已连接");
    expect(line).toContain("精力 80 · 心情 70 · 社交 50 · 休息中");
    expect(find(get("statusline"), (el) => el.className === "dot connected")).toBeDefined();
  });

  it("cycles the theme and remembers it", async () => {
    const { get, documentElement, stored } = await loadApp();
    expect(get("theme").textContent).toBe("跟随系统");
    get("theme").dispatch("click");
    expect(documentElement.dataset.theme).toBe("light");
    expect(stored.get("vex.theme")).toBe("light");
    get("theme").dispatch("click");
    expect(documentElement.dataset.theme).toBe("dark");
    get("theme").dispatch("click");
    expect(documentElement.dataset.theme).toBeUndefined();
    expect(stored.has("vex.theme")).toBe(false);
    expect(get("theme").textContent).toBe("跟随系统");
  });

  it("opens the session drawer on phones and closes it when a session is picked", async () => {
    const { get } = await loadApp();
    get("menu").dispatch("click");
    expect(get("app").className).toBe("drawer-open");
    expect(get("scrim").hidden).toBe(false);
    get("session-list").children[1]!.children[0]!.dispatch("click");
    expect(get("app").className).toBe("");
    expect(get("scrim").hidden).toBe(true);
    expect(get("topbar-title").textContent).toBe("二");
    get("menu").dispatch("click");
    get("scrim").dispatch("click");
    expect(get("app").className).toBe("");
  });

  it("clears input after a successful send", async () => {
    const { get, socket, context } = await loadApp();
    get("input").value = "  已发送  ";
    get("composer").dispatch("submit");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "send", sessionId: "one", text: "已发送" }));
    expect(get("input").value).toBe("");
    expect(runInContext('send({ type: "stop", sessionId: "one" })', context)).toBe(true);
    socket.readyState = 3;
    expect(runInContext('send({ type: "stop", sessionId: "one" })', context)).toBe(false);
  });
});
