import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { applySettings } from "../src/config/settings.js";
import { resolvePaths } from "../src/paths.js";

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
    setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(), prompt, confirm: () => true,
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
    expect(prompt).toHaveBeenCalledWith("Conversation name", "二");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "rename_session", sessionId: "two", title: "新标题" }));
  });

  it.each(["closed", "throw"])("preserves input when sending over a %s connection", async (failure) => {
    const { get, socket } = await loadApp();
    if (failure === "closed") socket.readyState = 3;
    else socket.send.mockImplementation(() => { throw new Error("connection closed"); });
    get("input").value = "  未发送的文本  ";
    get("composer").dispatch("submit");
    expect(get("input").value).toBe("  未发送的文本  ");
    expect(get("status").textContent).toBe("Connection lost; reconnecting…");
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
    expect(get("settings-result").textContent).toBe("Saved; takes effect after vexd restarts");
    runInContext('handle({ type: "settings_saved", ok: true, restartRequired: false })', context);
    expect(get("settings-result").textContent).toBe("Saved; takes effect immediately");
    runInContext('handle({ type: "settings_saved", ok: false, error: "model 无效" })', context);
    expect(get("settings-result").textContent).toBe("model 无效");
    expect(get("settings-result").className).toBe("bad");
  });

  it("saves a custom provider address that the server accepts", async () => {
    const { get, socket, context } = await loadApp();
    get("open-settings").dispatch("click");
    runInContext(`handle(${settingsMessage({ "model.provider": "custom", "model.id": "m", "providers.custom.baseUrl": "https://old.example", "providers.custom.api": "openai-completions" })})`, context);
    const base = find(get("settings-form"), (el) => el.id === "f-base-model-provider")!;
    expect(base.value).toBe("https://old.example");
    base.value = "https://new.example";
    base.dispatch("input");
    get("save-settings").dispatch("click");
    const sent = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(sent).toEqual({ type: "save_settings", set: { "providers.custom.baseUrl": "https://new.example" }, unset: [] });
    const yaml = "model: { provider: custom, id: m }\nproviders:\n  custom: { baseUrl: https://old.example, api: openai-completions }\n";
    expect(applySettings(yaml, { set: sent.set, unset: sent.unset }, resolvePaths("/tmp/vex-web-app-test")).text).toContain("https://new.example");
  });

  it("sends typed secrets, clears saved ones and skips a save with no changes", async () => {
    const { get, socket, context, call } = await loadApp();
    get("open-settings").dispatch("click");
    runInContext(`handle(${settingsMessage({ "model.provider": "deepseek", "model.id": "x", "stt.baseUrl": "https://s/v1", "stt.model": "w" }, ["providers.deepseek.apiKey", "stt.apiKey"])})`, context);
    const sends = socket.send.mock.calls.length;
    get("save-settings").dispatch("click");
    expect(socket.send.mock.calls.length).toBe(sends);
    expect(get("settings-result").textContent).toBe("No changes");
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

  it("shows only the fields of the chosen web search service", async () => {
    const { get, socket, context } = await loadApp();
    get("open-settings").dispatch("click");
    runInContext(`handle(${settingsMessage({ "model.provider": "deepseek", "model.id": "x" })})`, context);
    get("settings-tabs").children[2]!.dispatch("click");
    const form = get("settings-form");
    expect(find(form, (el) => el.id === "f-webSearch-apiKey")).toBeUndefined();
    expect(find(form, (el) => el.id === "f-webSearch-baseUrl")).toBeUndefined();
    const provider = find(form, (el) => el.id === "f-webSearch-provider")!;
    provider.value = "searxng";
    provider.dispatch("change");
    expect(find(get("settings-form"), (el) => el.id === "f-webSearch-apiKey")).toBeUndefined();
    const base = find(get("settings-form"), (el) => el.id === "f-webSearch-baseUrl")!;
    base.value = "http://searxng:8080";
    base.dispatch("input");
    get("save-settings").dispatch("click");
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: "save_settings", set: { "webSearch.provider": "searxng", "webSearch.baseUrl": "http://searxng:8080" }, unset: [] });
    find(get("settings-form"), (el) => el.id === "f-webSearch-provider")!.value = "tavily";
    find(get("settings-form"), (el) => el.id === "f-webSearch-provider")!.dispatch("change");
    expect(find(get("settings-form"), (el) => el.id === "f-webSearch-apiKey")).toBeDefined();
  });

  it("edits the notes vault settings and never fills the saved token", async () => {
    const { get, socket, context } = await loadApp();
    get("open-settings").dispatch("click");
    runInContext(`handle(${settingsMessage({ "model.provider": "deepseek", "model.id": "x" }, ["vault.token"])})`, context);
    get("settings-tabs").children[2]!.dispatch("click");
    const form = get("settings-form");
    expect(textOf(form)).toContain("Notes vault");
    const token = find(form, (el) => el.id === "f-vault-token")!;
    expect(token.value).toBe("");
    expect((token as unknown as { placeholder: string }).placeholder).toBe("Set; leave empty to keep it");
    const url = find(form, (el) => el.id === "f-vault-url")!;
    url.value = "https://git.example/me/notes.git";
    url.dispatch("input");
    const user = find(form, (el) => el.id === "f-vault-username")!;
    user.value = "me";
    user.dispatch("input");
    get("save-settings").dispatch("click");
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: "save_settings", set: { "vault.url": "https://git.example/me/notes.git", "vault.username": "me" }, unset: [] });
    for (const id of ["f-vault-path", "f-vault-branch"]) expect(find(form, (el) => el.id === id)).toBeDefined();
  });

  it("builds patches for cleared values, paired times and the shared background model", async () => {
    const { context, call } = await loadApp();
    runInContext(`handle(${settingsMessage({ "model.provider": "deepseek", "model.id": "a", "backgroundModel.provider": "deepseek", "backgroundModel.id": "b", "heartbeat.every": "30m", "persona.sleep": ["23:00", "07:00"] }, ["links.bilibili.sessdata"])})`, context);
    runInContext(`const d = state.settings.draft; d["background.same"] = true; d["heartbeat.every"] = ""; d["persona.sleep"] = ["22:00", "06:00"]; state.settings.cleared.add("links.bilibili.sessdata");`, context);
    const patch = call("buildPatch(state.settings)");
    expect(patch.set).toEqual({ "persona.sleep": ["22:00", "06:00"] });
    expect(patch.unset.sort()).toEqual(["backgroundModel.id", "backgroundModel.provider", "heartbeat.every", "links.bilibili.sessdata"]);
  });

  it("switches between the persona pages and the raw configuration", async () => {
    const { get, socket, context } = await loadApp();
    const area = (name: string) => runInContext(`state.fileAreas.get(${JSON.stringify(name)})`, context) as Element;
    get("open-settings").dispatch("click");
    get("settings-tabs").children[4]!.dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "get_file", name: "SOUL.md" }));
    runInContext('handle({ type: "file", name: "USER.md", text: "过期的回复" })', context);
    expect(area("SOUL.md").value).toBe("");
    runInContext('handle({ type: "file", name: "SOUL.md", text: "你是一只猫" })', context);
    expect(area("SOUL.md").value).toBe("你是一只猫");
    get("file-tabs").children[1]!.dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "get_file", name: "USER.md" }));
    area("USER.md").value = "喜欢咖啡";
    get("save-settings").dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "save_file", name: "USER.md", text: "喜欢咖啡" }));
    runInContext('handle({ type: "file_saved", name: "USER.md", ok: true })', context);
    expect(get("settings-result").textContent).toBe("Saved; applies from its next use");
    expect(get("settings-text").hidden).toBe(true);
    get("settings-tabs").children[6]!.dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "get_config" }));
    expect(get("settings-text").hidden).toBe(false);
    expect(get("file-editors").hidden).toBe(true);
    runInContext('handle({ type: "config", text: "model: {}" })', context);
    expect(get("settings-text").value).toBe("model: {}");
    get("save-settings").dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "save_config", text: "model: {}" }));
  });

  it("groups the persona files into four pages and saves every editor on the open page", async () => {
    const { get, socket, context } = await loadApp();
    get("open-settings").dispatch("click");
    get("settings-tabs").children[4]!.dispatch("click");
    expect(get("file-tabs").children.map((button) => button.textContent)).toEqual(["Persona", "About me", "Memory", "Heartbeat"]);
    get("file-tabs").children[3]!.dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "get_file", name: "HEARTBEAT.md" }));
    runInContext('state.fileAreas.get("HEARTBEAT.md").value = "check mail"', context);
    get("save-settings").dispatch("click");
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "save_file", name: "HEARTBEAT.md", text: "check mail" }));
    runInContext('handle({ type: "file_saved", name: "HEARTBEAT.md", ok: true, warning: "Too long." })', context);
    expect(get("settings-result").textContent).toBe("Saved. Too long.");
    expect(get("settings-result").className).toBe("warn");
    get("save-settings").dispatch("click");
    runInContext('handle({ type: "file_saved", name: "HEARTBEAT.md", ok: false, error: "Save failed" })', context);
    expect(get("settings-result").textContent).toBe("Save failed");
  });

  it("shows the daily notes under long-term memory, newest first, and saves the open one", async () => {
    const { get, socket, context } = await loadApp();
    const sent = () => socket.send.mock.calls.map((call) => JSON.parse(call[0]));
    get("open-settings").dispatch("click");
    get("settings-tabs").children[4]!.dispatch("click");
    get("file-tabs").children[2]!.dispatch("click");
    expect(sent().slice(-2)).toEqual([{ type: "get_file", name: "MEMORY.md" }, { type: "list_notes" }]);
    expect(textOf(get("file-editors"))).toContain("Daily notes");
    runInContext('handle({ type: "notes", names: [] })', context);
    expect(textOf(get("file-editors"))).toContain("No daily notes yet.");
    runInContext('handle({ type: "notes", names: ["memory/2026-10-05.md", "memory/2026-10-04.md"] })', context);
    const select = runInContext("state.notes.select", context) as Element & { value: string };
    expect(select.children.map((option) => option.textContent)).toEqual(["2026-10-05", "2026-10-04"]);
    expect(sent().at(-1)).toEqual({ type: "get_file", name: "memory/2026-10-05.md" });
    runInContext('handle({ type: "file", name: "memory/2026-10-05.md", text: "- deploy cmp" })', context);
    expect(runInContext('state.notes.area.value', context)).toBe("- deploy cmp");
    select.value = "memory/2026-10-04.md";
    select.dispatch("change");
    expect(sent().at(-1)).toEqual({ type: "get_file", name: "memory/2026-10-04.md" });
    runInContext('handle({ type: "file", name: "memory/2026-10-05.md", text: "stale" })', context);
    expect(runInContext('state.notes.area.value', context)).toBe("");
    runInContext('state.notes.area.value = "older note"; state.fileAreas.get("MEMORY.md").value = "facts"', context);
    get("save-settings").dispatch("click");
    expect(sent().slice(-2)).toEqual([
      { type: "save_file", name: "MEMORY.md", text: "facts" },
      { type: "save_file", name: "memory/2026-10-04.md", text: "older note" },
    ]);
    runInContext('handle({ type: "file_saved", name: "MEMORY.md", ok: true })', context);
    expect(get("settings-result").textContent).toBe("Saving…");
    runInContext('handle({ type: "file_saved", name: "memory/2026-10-04.md", ok: true })', context);
    expect(get("settings-result").textContent).toBe("Saved; applies from its next use");
  });

  it("lists, pauses, deletes and creates scheduled tasks from the Schedules tab", async () => {
    const { get, socket, context } = await loadApp();
    const last = () => JSON.parse(socket.send.mock.calls.at(-1)![0]);
    get("open-settings").dispatch("click");
    get("settings-tabs").children[5]!.dispatch("click");
    expect(last()).toEqual({ type: "get_schedules" });
    expect(get("save-settings").hidden).toBe(true);
    const task = { id: "t1", name: "Morning news", prompt: "search AI news", target: "wechat", enabled: true, schedule: { cron: "0 9 * * *" }, nextAt: 1791162000000 };
    runInContext(`handle(${JSON.stringify({ type: "schedules", tasks: [task], targets: [{ id: "wechat", label: "WeChat" }, { id: "one", label: "一" }] })})`, context);
    const list = get("schedule-list");
    expect(textOf(list)).toContain("Morning news");
    expect(textOf(list)).toContain("Every day at 09:00");
    expect(textOf(list)).toContain("To WeChat");
    const button = (label: string) => find(list, (el) => el.tagName === "button" && el.textContent === label)!;
    button("Pause").dispatch("click");
    expect(last()).toEqual({ type: "save_schedule", id: "t1", name: "Morning news", prompt: "search AI news", target: "wechat", enabled: false, schedule: { cron: "0 9 * * *" } });
    button("Delete").dispatch("click");
    expect(last()).toEqual({ type: "delete_schedule", id: "t1" });
    button("New task").dispatch("click");
    const form = get("schedule-list");
    const input = (id: string) => find(form, (el) => el.id === id)!;
    input("schedule-name").value = "Stretch"; input("schedule-name").dispatch("input");
    input("schedule-value").value = "*/30 * * * *"; input("schedule-value").dispatch("input");
    input("schedule-target").value = "one"; input("schedule-target").dispatch("change");
    input("schedule-prompt").value = "remind me to stretch"; input("schedule-prompt").dispatch("input");
    find(form, (el) => el.tagName === "button" && el.textContent === "Save task")!.dispatch("click");
    expect(last()).toEqual({ type: "save_schedule", name: "Stretch", prompt: "remind me to stretch", target: "one", enabled: true, schedule: { cron: "*/30 * * * *" } });
    runInContext('handle({ type: "schedule_saved", ok: false, error: "Invalid schedule rule" })', context);
    expect(get("settings-result").textContent).toBe("Invalid schedule rule");
    runInContext('handle({ type: "schedule_saved", ok: true })', context);
    expect(runInContext("state.editingSchedule", context)).toBeNull();
  });

  it("describes schedule rules and converts a one-time pick to an absolute time", async () => {
    const { get, socket, context, call } = await loadApp();
    expect(call('describeRule({ cron: "30 22 * * 1-5" })')).toBe("Weekdays at 22:30");
    expect(call('describeRule({ cron: "0 */2 * * *" })')).toBe("Cron 0 */2 * * *");
    expect(call('describeRule({ every: "45m" })')).toBe("Every 45m");
    get("open-settings").dispatch("click");
    get("settings-tabs").children[5]!.dispatch("click");
    runInContext('handle({ type: "schedules", tasks: [], targets: [{ id: "wechat", label: "WeChat" }] })', context);
    find(get("schedule-list"), (el) => el.tagName === "button" && el.textContent === "New task")!.dispatch("click");
    const input = (id: string) => find(get("schedule-list"), (el) => el.id === id)!;
    input("schedule-kind").value = "once"; input("schedule-kind").dispatch("change");
    input("schedule-name").value = "Call mum"; input("schedule-name").dispatch("input");
    input("schedule-value").value = "2030-01-02T08:30"; input("schedule-value").dispatch("input");
    input("schedule-prompt").value = "remind me to call mum"; input("schedule-prompt").dispatch("input");
    find(get("schedule-list"), (el) => el.tagName === "button" && el.textContent === "Save task")!.dispatch("click");
    const sent = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(sent.schedule.once).toBe(new Date("2030-01-02T08:30").toISOString());
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
    expect(line).toContain("WeChat connected");
    expect(line).toContain("Energy 80 · Mood 70 · Social 50 · Resting");
    expect(find(get("statusline"), (el) => el.className === "dot connected")).toBeDefined();
  });

  it("cycles the theme and remembers it", async () => {
    const { get, documentElement, stored } = await loadApp();
    expect(get("theme").textContent).toBe("System");
    get("theme").dispatch("click");
    expect(documentElement.dataset.theme).toBe("light");
    expect(stored.get("vex.theme")).toBe("light");
    get("theme").dispatch("click");
    expect(documentElement.dataset.theme).toBe("dark");
    get("theme").dispatch("click");
    expect(documentElement.dataset.theme).toBeUndefined();
    expect(stored.has("vex.theme")).toBe(false);
    expect(get("theme").textContent).toBe("System");
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
