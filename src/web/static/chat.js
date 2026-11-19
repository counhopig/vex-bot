// @ts-check
/** @typedef {Extract<import("../../protocol/messages.js").ClientMessage, { type: "approve" }>["answer"]} ApprovalAnswer */

import { renderMarkdown } from "./markdown.js";
import { send } from "./net.js";
import { state } from "./state.js";
import { $, $field, closeDrawer, element } from "./ui.js";


export function ensureCurrentSession() {
  if (state.currentId && state.sessions.some((s) => s.id === state.currentId)) return;
  const remembered = readRemembered();
  const target = state.sessions.find((s) => s.id === remembered) ?? state.sessions[0];
  if (target) selectSession(target.id);
  else createSession();
}

export function createSession() {
  if (state.creating) return;
  state.creating = true;
  closeDrawer();
  send({ type: "create_session" });
}

export function selectSession(id) {
  state.currentId = id;
  remember(id);
  clearMessages();
  for (const row of /** @type {HTMLCollectionOf<HTMLElement>} */ ($("session-list").children)) row.className = row.dataset.sessionId === id ? "active" : "";
  updateTopbar();
  closeDrawer();
  showChatFromSession();
  send({ type: "open", sessionId: id });
}

export function renameSession(session) {
  const next = prompt("Conversation name", session.title);
  if (next && next.trim()) send({ type: "rename_session", sessionId: session.id, title: next.trim() });
}

export function renderSessions() {
  const list = $("session-list");
  list.replaceChildren();
  for (const session of state.sessions) {
    const li = document.createElement("li");
    li.dataset.sessionId = session.id;
    li.className = session.id === state.currentId ? "active" : "";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = session.title;
    title.title = "Double-click to rename";
    title.addEventListener("click", () => selectSession(session.id));
    title.addEventListener("dblclick", () => renameSession(session));
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "icon";
    rename.textContent = "✎\uFE0E";
    rename.title = "Rename";
    rename.setAttribute("aria-label", `Rename "${session.title}"`);
    rename.addEventListener("click", () => renameSession(session));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon";
    remove.textContent = "×";
    remove.title = "Delete";
    remove.setAttribute("aria-label", `Delete "${session.title}"`);
    remove.addEventListener("click", () => {
      if (confirm(`Delete "${session.title}"?`)) send({ type: "delete_session", sessionId: session.id });
    });
    li.append(title, rename, remove);
    list.append(li);
  }
  updateTopbar();
}

function updateTopbar() {
  const current = state.sessions.find((s) => s.id === state.currentId);
  $("topbar-title").textContent = current ? current.title : "Vex";
}

function clearMessages() {
  $("messages").replaceChildren();
  state.streamEl = null;
  state.streamText = "";
  state.toolEls.clear();
  state.nextBefore = undefined;
  state.loadingHistory = false;
  state.historyButton = null;
  setBusy(false);
}

export function renderHistory(msg) {
  const older = msg.before !== undefined;
  // Ignore a page superseded by a reconnect or another history request.
  if (older && msg.before !== state.nextBefore) return;
  const box = $("messages");
  const previousHeight = box.scrollHeight;
  const previousTop = box.scrollTop;
  const existing = older ? [...box.children].filter((node) => node !== state.historyButton) : [];
  if (older) { state.historyButton?.remove(); }
  else clearMessages();
  for (const item of msg.items) {
    if (item.kind === "user") { if (item.source) addNotice(`${item.source}：${item.text}`); else addBubble("user", item.text); }
    else if (item.kind === "assistant") addBubble("assistant", item.text, item.stopReason === "aborted");
    else addTool(item.toolCallId, item.toolName, item.summary, item.isError === undefined ? "running" : item.isError ? "error" : "done");
  }
  if (older) {
    const appended = [...box.children].filter((node) => !existing.includes(node));
    box.replaceChildren(...appended, ...existing);
  }
  state.nextBefore = msg.nextBefore;
  state.loadingHistory = false;
  state.historyButton = null;
  if (msg.nextBefore !== undefined) {
    const button = element("button", "secondary", "Earlier messages");
    button.type = "button";
    button.addEventListener("click", () => {
      if (state.loadingHistory) return;
      if (send({ type: "open", sessionId: state.currentId, before: state.nextBefore })) {
        state.loadingHistory = true;
        button.disabled = true;
      }
    });
    box.prepend(button);
    state.historyButton = button;
  }
  if (older) {
    box.scrollTop = previousTop + box.scrollHeight - previousHeight;
    return;
  }
  if (msg.streaming !== undefined) {
    state.streamText = msg.streaming;
    state.streamEl = addBubble("assistant streaming", msg.streaming);
  }
  setBusy(msg.busy);
}

export function applyEvent(event) {
  switch (event.kind) {
    case "user_message":
      if (event.source) addNotice(`${event.source}：${event.text}`); else addBubble("user", event.text);
      break;
    case "text_delta":
      if (!state.streamEl) { state.streamText = ""; state.streamEl = addBubble("assistant streaming", ""); }
      state.streamText += event.delta;
      scheduleStreamRender();
      break;
    case "assistant_message":
      if (state.streamEl) {
        state.streamEl.remove();
        state.streamEl = null;
        state.streamText = "";
      }
      addBubble("assistant", event.text, event.stopReason === "aborted");
      break;
    case "tool_start":
      addTool(event.toolCallId, event.toolName, event.summary, "running");
      break;
    case "tool_end":
      updateTool(event.toolCallId, event.isError ? "error" : "done");
      break;
    case "tool_update": {
      const el = state.toolEls.get(event.toolCallId);
      if (el && event.text) {
        const progress = el.children[1];
        progress.textContent = (progress.textContent + event.text).slice(-2000);
        scrollToBottom();
      }
      break;
    }
    case "busy":
      setBusy(event.busy);
      if (!event.busy && state.streamEl) {
        state.streamEl.className = state.streamEl.className.replace(" streaming", "");
        state.streamEl = null;
      }
      break;
    case "error":
      addNotice(event.message);
      break;
  }
}

export function scheduleStreamRender() {
  if (state.streamFrame) return;
  state.streamFrame = true;
  const render = () => {
    state.streamFrame = false;
    if (!state.streamEl) return;
    renderMarkdown(state.streamEl.firstChild, state.streamText);
    scrollToBottom();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(render);
  else render();
}

export function addBubble(kind, text, aborted = false) {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  const body = document.createElement("div");
  body.className = kind.startsWith("assistant") ? "text md" : "text";
  if (kind.startsWith("assistant")) renderMarkdown(body, text);
  else body.textContent = text;
  el.append(body);
  if (aborted) {
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = "(interrupted)";
    el.append(tag);
  }
  $("messages").append(el);
  scrollToBottom();
  return el;
}

export const TOOL_ICONS = { running: "⋯", done: "✓", error: "✗" };

function addTool(id, name, summary, status) {
  const el = document.createElement("div");
  el.className = `tool ${status}`;
  el.dataset.label = `${name}：${summary}`;
  const head = document.createElement("div");
  head.className = "tool-head";
  head.textContent = `${TOOL_ICONS[status]} ${el.dataset.label}`;
  const progress = document.createElement("div");
  progress.className = "tool-progress";
  el.append(head, progress);
  $("messages").append(el);
  state.toolEls.set(id, el);
  scrollToBottom();
}

function updateTool(id, status) {
  const el = state.toolEls.get(id);
  if (!el) return;
  el.className = `tool ${status}`;
  el.firstChild.textContent = `${TOOL_ICONS[status]} ${el.dataset.label}`;
}

export function addNotice(text) {
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = text;
  $("messages").append(el);
  scrollToBottom();
}

export function setBusy(busy) {
  state.busy = busy;
  $("stop").hidden = !busy;
}

export function renderApprovals() {
  const box = $("approvals");
  box.replaceChildren();
  for (const request of state.pending) {
    const card = document.createElement("div");
    card.className = "approval";
    const head = document.createElement("div");
    head.className = "approval-head";
    const deadline = new Date(request.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    head.textContent = `#${request.code} ${request.windowLabel} wants to run ${request.toolName} (denied automatically if there is no answer by ${deadline})`;
    const detail = document.createElement("pre");
    detail.textContent = request.detail;
    const actions = document.createElement("div");
    actions.className = "approval-actions";
    for (const [answer, label, cls] of /** @type {[ApprovalAnswer, string, string][]} */ ([
      ["allow", "Allow", ""],
      ...(request.everyCall ? [] : [["allow_session", `Always allow ${request.allowScope ?? request.toolName} in this conversation`, "secondary"]]),
      ["deny", "Deny", "danger"],
    ])) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.className = cls;
      button.addEventListener("click", () => send({ type: "approve", id: request.id, answer }));
      actions.append(button);
    }
    card.append(head, detail, actions);
    box.append(card);
  }
}

export function renderTasks() {
  const box = $("tasks");
  box.replaceChildren();
  for (const task of state.tasks) {
    const row = element("div", "task");
    const started = new Date(task.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    row.append(element("span", "task-title", task.title), element("span", "task-meta", `${sessionLabel(task.origin)} · since ${started}`));
    const actions = element("span", "task-actions");
    const action = (label, onClick) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link";
      button.textContent = label;
      button.addEventListener("click", onClick);
      actions.append(button);
    };
    if (task.traceId) action("Trace", () => openTrace(task.traceId));
    action("Stop", () => { if (confirm(`Stop the background task "${task.title}"?`)) send({ type: "stop_task", id: task.id }); });
    row.append(actions);
    box.append(row);
  }
}

/** Work a source would have done, recorded because the source is set to record only. */
export function renderTriggers() {
  const box = $("triggers");
  box.replaceChildren();
  if (!state.triggers.length) return;
  box.append(element("p", "hint", `Recorded instead of run (${state.triggers.length})`));
  for (const trigger of state.triggers) {
    const card = document.createElement("details");
    card.className = "trigger";
    const summary = document.createElement("summary");
    const at = new Date(trigger.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    summary.append(element("span", "trigger-title", trigger.title), element("span", "trigger-meta", `${trigger.source} · ${at}`));
    card.append(summary, element("p", "trigger-text", trigger.text));
    box.append(card);
  }
}


export function scrollToBottom() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

function remember(id) {
  try {
    localStorage.setItem("vex.session", id);
  } catch {
    // Storage can be unavailable in private windows.
  }
}

function readRemembered() {
  try {
    return localStorage.getItem("vex.session");
  } catch {
    return null;
  }
}

export function sessionLabel(key) {
  if (key === "wechat") return "WeChat";
  if (key.startsWith("web:")) return state.sessions.find((session) => session.id === key.slice(4))?.title ?? "WebChat";
  if (key.startsWith("run:")) return "Background";
  return key;
}

/** Set by the app core: opens the trace viewer on a background task's run. */
/** @type {(id: string) => void} */
let openTrace = () => {};
export function setOpenTrace(open) { openTrace = open; }

/** Set by the app core: selecting a session returns the UI to the chat page. */
/** @type {() => void} */
let showChatFromSession = () => {};
export function setShowChat(open) { showChatFromSession = open; }
