const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  retryMs: 1000,
  sessions: [],
  currentId: null,
  creating: false,
  busy: false,
  pending: [],
  streamEl: null,
  toolEls: new Map(),
};

function send(message) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.send(JSON.stringify(message));
      return true;
    } catch {
      // The connection can close between the ready-state check and send.
    }
  }
  setStatus("连接已断开，正在重连…");
  return false;
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    state.retryMs = 1000;
    setStatus("");
    if (state.currentId) send({ type: "open", sessionId: state.currentId });
  });
  ws.addEventListener("message", (event) => handle(JSON.parse(event.data)));
  ws.addEventListener("close", () => {
    setStatus("连接已断开，正在重连…");
    setTimeout(connect, state.retryMs);
    state.retryMs = Math.min(state.retryMs * 2, 10000);
  });
}

function handle(msg) {
  switch (msg.type) {
    case "sessions":
      state.sessions = msg.sessions;
      renderSessions();
      ensureCurrentSession();
      break;
    case "session_created":
      state.creating = false;
      selectSession(msg.session.id);
      break;
    case "history":
      if (msg.sessionId === state.currentId) renderHistory(msg);
      break;
    case "event":
      if (msg.sessionId === state.currentId) applyEvent(msg.event);
      else if (msg.event.kind === "user_message" && msg.event.source) {
        const session = state.sessions.find(s => s.id === msg.sessionId);
        flash(`${session?.title ?? "网页会话"}：${msg.event.source}`);
      }
      break;
    case "approvals":
      state.pending = msg.pending;
      renderApprovals();
      break;
    case "config":
      $("config-text").value = msg.text;
      break;
    case "config_saved":
      $("config-result").textContent = msg.ok ? "已保存，重启 vexd 后生效" : msg.error;
      $("config-result").className = msg.ok ? "ok" : "bad";
      break;
    case "error":
      flash(msg.message);
      break;
  }
}

function ensureCurrentSession() {
  if (state.currentId && state.sessions.some((s) => s.id === state.currentId)) return;
  const remembered = readRemembered();
  const target = state.sessions.find((s) => s.id === remembered) ?? state.sessions[0];
  if (target) selectSession(target.id);
  else createSession();
}

function createSession() {
  if (state.creating) return;
  state.creating = true;
  send({ type: "create_session" });
}

function selectSession(id) {
  state.currentId = id;
  remember(id);
  clearMessages();
  for (const row of $("session-list").children) row.className = row.dataset.sessionId === id ? "active" : "";
  showChat();
  send({ type: "open", sessionId: id });
}

function renderSessions() {
  const list = $("session-list");
  list.replaceChildren();
  for (const session of state.sessions) {
    const li = document.createElement("li");
    li.dataset.sessionId = session.id;
    li.className = session.id === state.currentId ? "active" : "";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = session.title;
    title.title = "双击改名";
    title.addEventListener("click", () => selectSession(session.id));
    title.addEventListener("dblclick", () => {
      const next = prompt("会话名称", session.title);
      if (next && next.trim()) send({ type: "rename_session", sessionId: session.id, title: next.trim() });
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon";
    remove.textContent = "×";
    remove.title = "删除";
    remove.addEventListener("click", () => {
      if (confirm(`删除「${session.title}」？`)) send({ type: "delete_session", sessionId: session.id });
    });
    li.append(title, remove);
    list.append(li);
  }
}

function clearMessages() {
  $("messages").replaceChildren();
  state.streamEl = null;
  state.toolEls.clear();
  setBusy(false);
}

function renderHistory(msg) {
  clearMessages();
  for (const item of msg.items) {
    if (item.kind === "user") { if (item.source) addNotice(`${item.source}：${item.text}`); else addBubble("user", item.text); }
    else if (item.kind === "assistant") addBubble("assistant", item.text, item.stopReason === "aborted");
    else addTool(item.toolCallId, item.toolName, item.summary, item.isError === undefined ? "running" : item.isError ? "error" : "done");
  }
  if (msg.streaming !== undefined) state.streamEl = addBubble("assistant streaming", msg.streaming);
  setBusy(msg.busy);
}

function applyEvent(event) {
  switch (event.kind) {
    case "user_message":
      if (event.source) addNotice(`${event.source}：${event.text}`); else addBubble("user", event.text);
      break;
    case "text_delta":
      if (!state.streamEl) state.streamEl = addBubble("assistant streaming", "");
      state.streamEl.firstChild.textContent += event.delta;
      scrollToBottom();
      break;
    case "assistant_message":
      if (state.streamEl) {
        state.streamEl.remove();
        state.streamEl = null;
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
      if (el && event.text) el.textContent += event.text;
      break;
    }
    case "busy":
      setBusy(event.busy);
      if (!event.busy && state.streamEl) {
        state.streamEl.classList.remove("streaming");
        state.streamEl = null;
      }
      break;
    case "error":
      addNotice(event.message);
      break;
  }
}

function addBubble(kind, text, aborted = false) {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text;
  el.append(body);
  if (aborted) {
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = "（已中断）";
    el.append(tag);
  }
  $("messages").append(el);
  scrollToBottom();
  return el;
}

const TOOL_ICONS = { running: "⋯", done: "✓", error: "✗" };

function addTool(id, name, summary, status) {
  const el = document.createElement("div");
  el.className = `tool ${status}`;
  el.dataset.label = `${name}：${summary}`;
  el.textContent = `${TOOL_ICONS[status]} ${el.dataset.label}`;
  $("messages").append(el);
  state.toolEls.set(id, el);
  scrollToBottom();
}

function updateTool(id, status) {
  const el = state.toolEls.get(id);
  if (!el) return;
  el.className = `tool ${status}`;
  el.textContent = `${TOOL_ICONS[status]} ${el.dataset.label}`;
}

function addNotice(text) {
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = text;
  $("messages").append(el);
  scrollToBottom();
}

function setBusy(busy) {
  state.busy = busy;
  $("stop").hidden = !busy;
}

function renderApprovals() {
  const box = $("approvals");
  box.replaceChildren();
  for (const request of state.pending) {
    const card = document.createElement("div");
    card.className = "approval";
    const head = document.createElement("div");
    head.className = "approval-head";
    const deadline = new Date(request.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    head.textContent = `${request.windowLabel} 请求执行 ${request.toolName}（${deadline} 前未答复将自动拒绝）`;
    const detail = document.createElement("pre");
    detail.textContent = request.detail;
    const actions = document.createElement("div");
    actions.className = "approval-actions";
    for (const [answer, label, cls] of [
      ["allow", "允许", ""],
      ["allow_session", "本会话总是允许", "secondary"],
      ["deny", "拒绝", "danger"],
    ]) {
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

function showChat() {
  $("settings").hidden = true;
  $("chat").hidden = false;
}

function showSettings() {
  $("chat").hidden = true;
  $("settings").hidden = false;
  $("config-result").textContent = "";
  send({ type: "get_config" });
}

function setStatus(text) {
  $("status").textContent = text;
  $("status").hidden = !text;
}

let flashTimer;
function flash(text) {
  setStatus(text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setStatus(""), 4000);
}

function scrollToBottom() {
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

function autoGrow() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("input");
  const text = input.value.trim();
  if (!text || !state.currentId) return;
  if (!send({ type: "send", sessionId: state.currentId, text })) return;
  input.value = "";
  autoGrow();
});

$("input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("input").addEventListener("input", autoGrow);
$("stop").addEventListener("click", () => {
  if (state.currentId) send({ type: "stop", sessionId: state.currentId });
});
$("new-session").addEventListener("click", createSession);
$("open-settings").addEventListener("click", showSettings);
$("close-settings").addEventListener("click", showChat);
$("save-config").addEventListener("click", () => {
  $("config-result").textContent = "保存中…";
  $("config-result").className = "";
  send({ type: "save_config", text: $("config-text").value });
});

connect();
