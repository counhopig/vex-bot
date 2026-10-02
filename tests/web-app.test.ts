import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  value = "";
  hidden = false;
  style: Record<string, string> = {};
  scrollHeight = 0;
  scrollTop = 0;
  private listeners = new Map<string, ((event: object) => void)[]>();

  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  addEventListener(type: string, listener: (event: object) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} });
  }
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
  const context = createContext({
    document: { getElementById: get, createElement: () => new Element() },
    WebSocket: Socket,
    location: { protocol: "http:", host: "localhost" },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: vi.fn(), clearTimeout: vi.fn(), prompt,
  });
  runInContext(await readFile(new URL("../src/web/static/app.js", import.meta.url), "utf8"), context);
  runInContext('handle({ type: "sessions", sessions: [{ id: "one", title: "一" }, { id: "two", title: "二" }] })', context);
  const socket = runInContext("state.ws", context) as Socket;
  return { get, context, socket, prompt };
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
