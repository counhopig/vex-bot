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
  streamText: "",
  streamFrame: false,
  toolEls: new Map(),
  statusInfo: null,
  settings: null,
  settingsTab: "model",
  filePage: "soul",
  fileAreas: new Map(),
  pendingSaves: 0,
  saveWarnings: [],
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
  setStatus("Connection lost; reconnecting…");
  return false;
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    state.retryMs = 1000;
    setStatus("");
    if (state.currentId) send({ type: "open", sessionId: state.currentId });
    send({ type: "get_status" });
    if (!$("settings").hidden && isFormTab(state.settingsTab)) send({ type: "get_settings" });
  });
  ws.addEventListener("message", (event) => handle(JSON.parse(event.data)));
  ws.addEventListener("close", () => {
    setStatus("Connection lost; reconnecting…");
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
        flash(`${session?.title ?? "WebChat conversation"}: ${msg.event.source}`);
      }
      break;
    case "approvals":
      state.pending = msg.pending;
      renderApprovals();
      break;
    case "status":
      state.statusInfo = msg.status;
      renderStatusLine();
      updateWechatStatus();
      break;
    case "settings":
      state.settings = makeSettings(msg);
      if (isFormTab(state.settingsTab)) renderSettingsForm();
      break;
    case "settings_saved":
      if (msg.ok) {
        showSaved(true, savedMessage(msg.restarting, msg.restartRequired));
        send({ type: "get_settings" });
      } else {
        showSaved(false, "", msg.error);
      }
      break;
    case "config":
      if (state.settingsTab === "yaml") $("settings-text").value = msg.text;
      break;
    case "file":
      if (state.fileAreas.has(msg.name)) state.fileAreas.get(msg.name).value = msg.text;
      break;
    case "config_saved":
      showSaved(msg.ok, savedMessage(msg.restarting, true), msg.error);
      break;
    case "file_saved":
      if (state.fileAreas.has(msg.name)) {
        if (!msg.ok) { state.pendingSaves = 0; showSaved(false, "", msg.error); break; }
        if (msg.warning) state.saveWarnings.push(msg.warning);
        if (--state.pendingSaves > 0) break;
        if (state.saveWarnings.length) {
          $("settings-result").textContent = `Saved. ${state.saveWarnings.join(" ")}`;
          $("settings-result").className = "warn";
        } else {
          showSaved(true, "Saved; applies from its next use");
        }
      }
      break;
    case "error":
      flash(msg.message);
      break;
  }
}

/* ---------- Markdown ---------- */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function startsBlock(line, next) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || /^\s{0,3}>/.test(line) || LIST_ITEM.test(line)
    || (line.includes("|") && next !== undefined && TABLE_DIVIDER.test(next) && next.includes("-"));
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

function parseList(lines, start) {
  const first = LIST_ITEM.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]);
    if (!match || match[1].length < baseIndent || (match[1].length === baseIndent && /\d/.test(match[2]) !== ordered)) break;
    if (match[1].length > baseIndent) {
      const nested = parseList(lines, i);
      const last = items[items.length - 1];
      if (last) last.blocks.push(nested.block);
      i = nested.next;
      continue;
    }
    const item = { inline: parseInline(match[3]), blocks: [] };
    items.push(item);
    i++;
    while (i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && /^\s+/.test(lines[i])) {
      item.inline.push({ t: "br" }, ...parseInline(lines[i].trim()));
      i++;
    }
  }
  return { block: { type: "list", ordered, items }, next: i };
}

function parseMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(marker[0].repeat(marker.length)) && lines[i].trim().replace(new RegExp(`^${marker[0]}+`), "") === "")) body.push(lines[i++]);
      i++;
      blocks.push({ type: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, inline: parseInline(heading[2]) }); i++; continue; }
    if (RULE.test(line)) { blocks.push({ type: "rule" }); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}> ?/, ""));
      blocks.push({ type: "quote", blocks: parseMarkdown(quoted.join("\n")) });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      blocks.push({ type: "table", head: head.map(parseInline), rows: rows.map((row) => row.map(parseInline)) });
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) paragraph.push(lines[i++]);
    const inline = [];
    paragraph.forEach((part, index) => { if (index) inline.push({ t: "br" }); inline.push(...parseInline(part.trim())); });
    blocks.push({ type: "paragraph", inline });
  }
  return blocks;
}

const INLINE_PATTERNS = [
  ["code", /`([^`\n]+)`/],
  ["link", /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/],
  ["bold", /\*\*(?=\S)([\s\S]*?\S)\*\*/],
  ["strike", /~~(?=\S)([\s\S]*?\S)~~/],
  ["italic", /(?<![*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/],
  ["italic", /(?<!\w)_(?=\S)([^_\n]*?\S)_(?!\w)/],
  ["url", /https?:\/\/[^\s<>()]+[^\s<>().,;:!?，。；：！？）」』]/],
];

function parseInline(text) {
  const nodes = [];
  let rest = text;
  while (rest) {
    let best;
    for (const [kind, pattern] of INLINE_PATTERNS) {
      const match = pattern.exec(rest);
      if (match && (!best || match.index < best.match.index)) best = { kind, match };
    }
    if (!best) { nodes.push({ t: "text", v: rest }); break; }
    const { kind, match } = best;
    if (match.index > 0) nodes.push({ t: "text", v: rest.slice(0, match.index) });
    if (kind === "code") nodes.push({ t: "code", v: match[1] });
    else if (kind === "link") nodes.push({ t: "link", href: match[2], c: parseInline(match[1]) });
    else if (kind === "url") nodes.push({ t: "link", href: match[0], c: [{ t: "text", v: match[0] }] });
    else nodes.push({ t: kind, c: parseInline(match[1]) });
    rest = rest.slice(match.index + match[0].length);
  }
  return nodes;
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderInline(parent, nodes) {
  for (const node of nodes) {
    switch (node.t) {
      case "text": parent.append(document.createTextNode(node.v)); break;
      case "br": parent.append(document.createElement("br")); break;
      case "code": parent.append(element("code", "", node.v)); break;
      case "link": {
        const a = element("a");
        a.href = node.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        renderInline(a, node.c);
        parent.append(a);
        break;
      }
      default: {
        const tag = { bold: "strong", italic: "em", strike: "del" }[node.t];
        const el = element(tag);
        renderInline(el, node.c);
        parent.append(el);
      }
    }
  }
}

function copyText(button, text) {
  const done = () => {
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1500);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => {});
}

function renderBlocks(parent, blocks) {
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph": { const p = element("p"); renderInline(p, block.inline); parent.append(p); break; }
      case "heading": { const h = element(`h${block.level}`); renderInline(h, block.inline); parent.append(h); break; }
      case "rule": parent.append(element("hr")); break;
      case "quote": { const q = element("blockquote"); renderBlocks(q, block.blocks); parent.append(q); break; }
      case "list": {
        const list = element(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const li = element("li");
          renderInline(li, item.inline);
          renderBlocks(li, item.blocks);
          list.append(li);
        }
        parent.append(list);
        break;
      }
      case "code": {
        const wrap = element("div", "code");
        const head = element("div", "code-head");
        head.append(element("span", "", block.lang || "code"));
        const copy = element("button", "", "Copy");
        copy.type = "button";
        copy.addEventListener("click", () => copyText(copy, block.text));
        head.append(copy);
        const pre = element("pre");
        pre.append(element("code", "", block.text));
        wrap.append(head, pre);
        parent.append(wrap);
        break;
      }
      case "table": {
        const wrap = element("div", "table-wrap");
        const table = element("table");
        const thead = element("thead");
        const headRow = element("tr");
        for (const cell of block.head) { const th = element("th"); renderInline(th, cell); headRow.append(th); }
        thead.append(headRow);
        const tbody = element("tbody");
        for (const row of block.rows) {
          const tr = element("tr");
          for (const cell of row) { const td = element("td"); renderInline(td, cell); tr.append(td); }
          tbody.append(tr);
        }
        table.append(thead, tbody);
        wrap.append(table);
        parent.append(wrap);
        break;
      }
    }
  }
}

function renderMarkdown(target, text) {
  target.replaceChildren();
  renderBlocks(target, parseMarkdown(text));
}

/* ---------- Sessions and messages ---------- */

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
  closeDrawer();
  send({ type: "create_session" });
}

function selectSession(id) {
  state.currentId = id;
  remember(id);
  clearMessages();
  for (const row of $("session-list").children) row.className = row.dataset.sessionId === id ? "active" : "";
  updateTopbar();
  closeDrawer();
  showChat();
  send({ type: "open", sessionId: id });
}

function renameSession(session) {
  const next = prompt("Conversation name", session.title);
  if (next && next.trim()) send({ type: "rename_session", sessionId: session.id, title: next.trim() });
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
  setBusy(false);
}

function renderHistory(msg) {
  clearMessages();
  for (const item of msg.items) {
    if (item.kind === "user") { if (item.source) addNotice(`${item.source}：${item.text}`); else addBubble("user", item.text); }
    else if (item.kind === "assistant") addBubble("assistant", item.text, item.stopReason === "aborted");
    else addTool(item.toolCallId, item.toolName, item.summary, item.isError === undefined ? "running" : item.isError ? "error" : "done");
  }
  if (msg.streaming !== undefined) {
    state.streamText = msg.streaming;
    state.streamEl = addBubble("assistant streaming", msg.streaming);
  }
  setBusy(msg.busy);
}

function applyEvent(event) {
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

function scheduleStreamRender() {
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

function addBubble(kind, text, aborted = false) {
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

const TOOL_ICONS = { running: "⋯", done: "✓", error: "✗" };

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
    const deadline = new Date(request.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    head.textContent = `${request.windowLabel} wants to run ${request.toolName} (denied automatically if there is no answer by ${deadline})`;
    const detail = document.createElement("pre");
    detail.textContent = request.detail;
    const actions = document.createElement("div");
    actions.className = "approval-actions";
    for (const [answer, label, cls] of [
      ["allow", "Allow", ""],
      ["allow_session", "Always allow in this conversation", "secondary"],
      ["deny", "Deny", "danger"],
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

/* ---------- Status line, drawer and theme ---------- */

const WECHAT_LABELS = { connected: "WeChat connected", connecting: "WeChat connecting", unlinked: "WeChat not linked", expired: "WeChat expired", disabled: "WeChat off" };

function renderStatusLine() {
  const line = $("statusline");
  line.replaceChildren();
  const info = state.statusInfo;
  if (!info) return;
  line.append(element("span", "", info.model));
  const wechat = element("span");
  wechat.append(element("span", `dot ${info.wechat}`), document.createTextNode(WECHAT_LABELS[info.wechat] ?? info.wechat));
  line.append(wechat);
  const { energy, mood, social, resting } = info.persona;
  line.append(element("span", "", `Energy ${energy} · Mood ${mood} · Social ${social}${resting ? " · Resting" : ""}`));
  if (info.reloadError) line.append(element("span", "warn", `The last saved settings could not start; the previous configuration was restored: ${info.reloadError}`));
}

function openDrawer() { $("app").className = "drawer-open"; $("scrim").hidden = false; }
function closeDrawer() { $("app").className = ""; $("scrim").hidden = true; }

const THEMES = [["", "System"], ["light", "Light"], ["dark", "Dark"]];

function currentTheme() {
  try {
    const stored = localStorage.getItem("vex.theme");
    return stored === "light" || stored === "dark" ? stored : "";
  } catch {
    return "";
  }
}

function applyTheme(mode) {
  if (mode) document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  $("theme").textContent = THEMES.find(([value]) => value === mode)[1];
}

function cycleTheme() {
  const next = THEMES[(THEMES.findIndex(([value]) => value === currentTheme()) + 1) % THEMES.length][0];
  try {
    if (next) localStorage.setItem("vex.theme", next);
    else localStorage.removeItem("vex.theme");
  } catch {
    // Storage can be unavailable in private windows.
  }
  applyTheme(next);
}

/* ---------- Settings ---------- */

const MODEL_FIELDS = [
  { path: "model.provider", label: "Provider", type: "provider", help: "Pick a built-in provider from the suggestions, or type the name of your own OpenAI- or Anthropic-compatible service." },
  { path: "model.id", label: "Model", type: "model", of: "model.provider", help: "Case-sensitive." },
  { path: "model.thinking", label: "Thinking level", type: "select", options: ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"], help: "Leave empty for the provider default." },
  { path: "key:model.provider", label: "API Key", type: "providerKey", of: "model.provider" },
  { path: "api:model.provider", label: "API protocol", type: "providerApi", of: "model.provider" },
  { path: "base:model.provider", label: "API address", type: "providerBase", of: "model.provider", help: "The baseUrl of your own service, for example https://example.com/v1." },
];

const BACKGROUND_FIELDS = [
  { path: "background.same", label: "Use the main model for background work", type: "bool", help: "The background model writes conversation titles, context summaries, heartbeats, memory consolidation and link summaries." },
  { path: "backgroundModel.provider", label: "Provider", type: "provider", when: (draft) => !draft["background.same"] },
  { path: "backgroundModel.id", label: "Model", type: "model", of: "backgroundModel.provider", when: (draft) => !draft["background.same"] },
  { path: "backgroundModel.thinking", label: "Thinking level", type: "select", options: ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"], when: (draft) => !draft["background.same"] },
  { path: "key:backgroundModel.provider", label: "API Key", type: "providerKey", of: "backgroundModel.provider", when: (draft) => !draft["background.same"] && draft["backgroundModel.provider"] !== draft["model.provider"] },
];

const SETTINGS_TABS = [
  { id: "model", label: "Model", sections: [{ title: "Main model", fields: MODEL_FIELDS }, { title: "Background model", fields: BACKGROUND_FIELDS }] },
  { id: "channel", label: "WeChat", sections: [{ title: "WeChat", status: true, fields: [
    { path: "wechat.enabled", label: "Enable WeChat", type: "bool", help: "When off, vexd does not connect to WeChat." },
    { path: "wechat.ownerId", label: "Owner's WeChat id", type: "text", help: "Leave empty to use the account that scanned the QR code. Only the owner's messages are answered." },
  ] }] },
  { id: "voice", label: "Voice & links", sections: [
    { title: "Speech to text", fields: [
      { path: "stt.baseUrl", label: "Service address", type: "text", placeholder: "https://api.openai.com/v1", help: "Any service compatible with OpenAI /audio/transcriptions. Bilibili and YouTube videos without subtitles are transcribed with it." },
      { path: "stt.model", label: "Model", type: "text", placeholder: "whisper-1" },
      { path: "stt.apiKey", label: "API Key", type: "secret" },
      { path: "stt.language", label: "Language hint", type: "text", placeholder: "zh" },
      { path: "stt.chunkMinutes", label: "Minutes per part", type: "number", min: 1, max: 30, help: "Lower it when the service limits the upload size; default 10." },
      { path: "stt.maxMinutes", label: "Longest video (minutes)", type: "number", min: 1, max: 600, help: "Longer videos are not transcribed; default 90." },
    ] },
    { title: "Reading links", fields: [
      { path: "links.bilibili.sessdata", label: "Bilibili SESSDATA", type: "secret", help: "After signing in to bilibili.com, copy SESSDATA from the browser developer tools under Application → Cookies. Most subtitles need a login to read; it is as good as your login credential, so keep it safe. Takes effect as soon as it is saved." },
    ] },
    { title: "Web search", fields: [
      { path: "webSearch.provider", label: "Search service", type: "select", options: ["", "tavily", "searxng", "brave"], rerender: true, labels: { "": "Off", tavily: "Tavily (1000 free searches a month)", searxng: "SearXNG (self-hosted, free)", brave: "Brave Search (paid)" } },
      { path: "webSearch.apiKey", label: "API Key", type: "secret", when: (draft) => ["tavily", "brave"].includes(draft["webSearch.provider"]), help: "The key for the chosen service; the environment variable TAVILY_API_KEY or BRAVE_API_KEY also works." },
      { path: "webSearch.baseUrl", label: "SearXNG address", type: "text", placeholder: "http://searxng:8080", when: (draft) => draft["webSearch.provider"] === "searxng", help: "SearXNG must have the json format enabled in settings.yml; see the documentation for how to deploy it." },
    ] },
  ] },
  { id: "life", label: "Routine", sections: [
    { title: "Heartbeat and consolidation", fields: [
      { path: "heartbeat.every", label: "Heartbeat interval", type: "text", placeholder: "30m", help: "A number followed by s, m, h or d. The model is not called while HEARTBEAT.md is empty." },
      { path: "heartbeat.activeHours", label: "Heartbeat hours", type: "times" },
      { path: "memory.consolidateAt", label: "Daily memory consolidation time", type: "time" },
      { path: "compaction.threshold", label: "Context compaction threshold", type: "number", min: 0.1, max: 1, step: 0.05, help: "History is compacted once it exceeds this share of the model's context window; default 0.7." },
    ] },
    { title: "Rest hours and proactive chat", fields: [
      { path: "persona.sleep", label: "Rest hours", type: "times", help: "During rest hours replies sound sleepier and there is no proactive chat." },
      { path: "persona.outreach.enabled", label: "Allow proactive chat", type: "bool" },
      { path: "persona.outreach.checkEvery", label: "Check interval", type: "text", placeholder: "30m" },
      { path: "persona.outreach.dailyLimit", label: "Most proactive chats per day", type: "number", min: 0 },
      { path: "persona.outreach.socialThreshold", label: "Social need threshold (0-100)", type: "number", min: 0, max: 100 },
      { path: "persona.outreach.quietHours", label: "Hours of silence before reaching out", type: "number", min: 0 },
    ] },
  ] },
  { id: "persona", label: "Persona & memory", pages: true },
  { id: "yaml", label: "Advanced", yaml: true },
];

const FILE_PAGES = [
  { id: "soul", label: "Persona", files: [{ name: "SOUL.md", hint: "Persona, tone and rules of conduct. Takes effect from the next message." }] },
  { id: "user", label: "About me", files: [{ name: "USER.md", hint: "What it knows about you: how to address you, who you are, preferences and habits. Takes effect from the next message." }] },
  { id: "memory", label: "Memory", files: [{ name: "MEMORY.md", hint: "Distilled long-term facts and decisions, kept under 100 lines. Takes effect from the next message." }] },
  { id: "background", label: "Background tasks", files: [
    { name: "HEARTBEAT.md", title: "Heartbeat checklist", hint: "Checked at every heartbeat; write any instructions for the heartbeat here too. Leave it empty to skip the checks." },
    { name: "prompts/consolidation.md", title: "Memory consolidation", hint: "The nightly consolidation task; {{dates}} becomes the paths of the last seven daily notes. Clear the text and save to restore the default." },
    { name: "prompts/outreach.md", title: "Proactive chat", hint: "The instruction used when Vex starts a conversation on its own. Clear the text and save to restore the default." },
  ] },
];
const YAML_HINT = "The full config.yaml. Change settings the forms do not cover (tool policy, MCP servers, the web token and so on) here; saving applies them automatically.";

const isFormTab = (id) => !!SETTINGS_TABS.find((tab) => tab.id === id)?.sections;
const secretPath = (field, draft) => field.type === "secret" ? field.path : `providers.${draft[field.of]}.apiKey`;

function makeSettings(msg) {
  const draft = { ...msg.values };
  draft["background.same"] = !(msg.values["backgroundModel.provider"] && msg.values["backgroundModel.id"]);
  return { loaded: { ...draft }, draft, secrets: new Set(msg.secrets), catalog: msg.catalog, typed: {}, cleared: new Set() };
}

function providerNames() {
  const names = new Set(state.settings.catalog.providers);
  for (const path of Object.keys(state.settings.draft)) {
    const match = /^providers\.([^.]+)\./.exec(path);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

function isCustomProvider(name) {
  return !!name && !state.settings.catalog.providers.includes(name);
}

function fieldLabel(field, draft) {
  return field.type === "providerKey" && draft[field.of] ? `API Key（${draft[field.of]}）` : field.label;
}

function renderField(field, draft) {
  const wrap = element("div", "field");
  const id = `f-${field.path.replace(/[^\w]/g, "-")}`;
  const label = element("label", "", fieldLabel(field, draft));
  label.htmlFor = id;
  const track = (input, read) => input.addEventListener("input", () => { draft[field.path] = read(input); });
  switch (field.type) {
    case "bool": {
      const row = element("label", "check");
      const box = element("input");
      box.type = "checkbox";
      box.id = id;
      box.checked = draft[field.path] === true;
      box.addEventListener("change", () => { draft[field.path] = box.checked; if (field.path === "background.same") renderSettingsForm(); });
      row.append(box, document.createTextNode(field.label));
      wrap.append(row);
      break;
    }
    case "select": {
      const select = element("select");
      select.id = id;
      for (const value of field.options) {
        const option = element("option", "", field.labels?.[value] ?? (value || "Default"));
        option.value = value;
        select.append(option);
      }
      select.value = draft[field.path] ?? "";
      select.addEventListener("change", () => { draft[field.path] = select.value; if (field.rerender) renderSettingsForm(); });
      wrap.append(label, select);
      break;
    }
    case "provider":
    case "model": {
      const input = element("input");
      input.type = "text";
      input.id = id;
      input.value = draft[field.path] ?? "";
      input.autocomplete = "off";
      const list = element("datalist");
      list.id = `${id}-list`;
      input.setAttribute("list", list.id);
      const options = field.type === "provider" ? providerNames() : state.settings.catalog.models[draft[field.of]] ?? [];
      for (const value of options) { const option = element("option"); option.value = value; list.append(option); }
      input.addEventListener("input", () => { draft[field.path] = input.value.trim(); });
      if (field.type === "provider") input.addEventListener("change", renderSettingsForm);
      wrap.append(label, input, list);
      break;
    }
    case "providerApi": {
      if (!isCustomProvider(draft[field.of])) return undefined;
      const select = element("select");
      select.id = id;
      for (const value of ["", "openai-completions", "anthropic-messages"]) { const option = element("option", "", value || "Choose"); option.value = value; select.append(option); }
      const key = `providers.${draft[field.of]}.api`;
      select.value = draft[key] ?? "";
      select.addEventListener("change", () => { draft[key] = select.value; });
      wrap.append(label, select);
      break;
    }
    case "providerBase": {
      if (!isCustomProvider(draft[field.of])) return undefined;
      const input = element("input");
      input.type = "text";
      input.id = id;
      const key = `providers.${draft[field.of]}.baseUrl`;
      input.value = draft[key] ?? "";
      track(input, (el) => { draft[key] = el.value.trim(); return el.value.trim(); });
      wrap.append(label, input);
      break;
    }
    case "secret":
    case "providerKey": {
      if (field.type === "providerKey" && !draft[field.of]) return undefined;
      const path = secretPath(field, draft);
      const input = element("input");
      input.type = "password";
      input.id = id;
      input.autocomplete = "new-password";
      input.value = state.settings.typed[path] ?? "";
      input.placeholder = state.settings.secrets.has(path) ? "Set; leave empty to keep it" : "Not set";
      input.addEventListener("input", () => { state.settings.typed[path] = input.value; });
      wrap.append(label, input);
      if (state.settings.secrets.has(path)) {
        const clear = element("label", "clear");
        const box = element("input");
        box.type = "checkbox";
        box.checked = state.settings.cleared.has(path);
        box.addEventListener("change", () => { if (box.checked) state.settings.cleared.add(path); else state.settings.cleared.delete(path); });
        clear.append(box, document.createTextNode("Clear the saved value"));
        wrap.append(clear);
      }
      break;
    }
    case "number": {
      const input = element("input");
      input.type = "number";
      input.id = id;
      if (field.min !== undefined) input.min = field.min;
      if (field.max !== undefined) input.max = field.max;
      if (field.step !== undefined) input.step = field.step;
      input.value = draft[field.path] ?? "";
      input.addEventListener("input", () => { draft[field.path] = input.value === "" ? "" : Number(input.value); });
      wrap.append(label, input);
      break;
    }
    case "time": {
      const input = element("input");
      input.type = "time";
      input.id = id;
      input.value = draft[field.path] ?? "";
      input.addEventListener("input", () => { draft[field.path] = input.value; });
      wrap.append(label, input);
      break;
    }
    case "times": {
      const pair = element("div", "pair");
      const current = Array.isArray(draft[field.path]) ? draft[field.path] : ["", ""];
      const inputs = [0, 1].map((index) => {
        const input = element("input");
        input.type = "time";
        input.value = current[index] ?? "";
        input.setAttribute("aria-label", index === 0 ? `${field.label} start` : `${field.label} end`);
        input.addEventListener("input", () => { draft[field.path] = [inputs[0].value, inputs[1].value]; });
        return input;
      });
      pair.append(inputs[0], document.createTextNode("to"), inputs[1]);
      wrap.append(element("span", "label", field.label), pair);
      break;
    }
    default: {
      const input = element("input");
      input.type = "text";
      input.id = id;
      input.value = draft[field.path] ?? "";
      if (field.placeholder) input.placeholder = field.placeholder;
      input.addEventListener("input", () => { draft[field.path] = input.value.trim(); });
      wrap.append(label, input);
    }
  }
  if (field.help) wrap.append(element("p", "help", field.help));
  return wrap;
}

function updateWechatStatus() {
  const hint = $("wechat-status");
  if (!hint) return;
  const info = state.statusInfo;
  hint.textContent = info ? `Status: ${WECHAT_LABELS[info.wechat] ?? info.wechat}. When WeChat is not linked or has expired, vexd shows a QR code in its log; scan it with WeChat on your phone, no restart needed.` : "Reading status…";
}

function renderSettingsForm() {
  const form = $("settings-form");
  form.replaceChildren();
  const tab = SETTINGS_TABS.find((item) => item.id === state.settingsTab);
  if (!tab?.sections) return;
  if (!state.settings) { form.append(element("p", "hint", "Loading…")); return; }
  for (const group of tab.sections) {
    const section = element("div", "section");
    section.append(element("h3", "", group.title));
    if (group.status) {
      const hint = element("p", "hint");
      hint.id = "wechat-status";
      section.append(hint);
    }
    for (const field of group.fields) {
      if (field.when && !field.when(state.settings.draft)) continue;
      const node = renderField(field, state.settings.draft);
      if (node) section.append(node);
    }
    form.append(section);
  }
  updateWechatStatus();
}

/** Turns the form's edits into the set and unset lists the server applies to config.yaml. */
function buildPatch(settings) {
  const { loaded, draft, secrets, typed, cleared } = settings;
  const set = {};
  const unset = [];
  const blank = (value) => value === undefined || value === "" || (Array.isArray(value) && value.every((item) => !item));
  const same = (a, b) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");
  const paths = new Set([...Object.keys(loaded), ...Object.keys(draft)]);
  paths.delete("background.same");
  for (const path of paths) {
    if (same(loaded[path], draft[path])) continue;
    if (path.startsWith("backgroundModel.") && draft["background.same"]) continue;
    if (blank(draft[path])) unset.push(path);
    else set[path] = Array.isArray(draft[path]) && draft[path].some((item) => !item) ? undefined : draft[path];
    if (set[path] === undefined) delete set[path];
  }
  if (draft["background.same"] && !loaded["background.same"]) {
    for (const key of ["provider", "id", "thinking"]) if (loaded[`backgroundModel.${key}`] !== undefined) unset.push(`backgroundModel.${key}`);
  }
  for (const [path, value] of Object.entries(typed)) if (value) set[path] = value;
  for (const path of cleared) if (secrets.has(path) && !typed[path]) unset.push(path);
  return { set, unset: [...new Set(unset)] };
}

function savedMessage(restarting, restartRequired) {
  if (restarting) return "Saved; applying the settings, reconnecting automatically in a few seconds…";
  return restartRequired ? "Saved; takes effect after vexd restarts" : "Saved; takes effect immediately";
}

function showSaved(ok, message, error) {
  $("settings-result").textContent = ok ? message : error;
  $("settings-result").className = ok ? "ok" : "bad";
}

function renderSettingsTabs() {
  const tabs = $("settings-tabs");
  tabs.replaceChildren();
  for (const tab of SETTINGS_TABS) {
    const button = element("button", tab.id === state.settingsTab ? "active" : "", tab.label);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => { state.settingsTab = tab.id; openSettingsTab(); });
    tabs.append(button);
  }
}

function renderFileTabs() {
  const tabs = $("file-tabs");
  tabs.replaceChildren();
  for (const page of FILE_PAGES) {
    const button = element("button", page.id === state.filePage ? "active" : "", page.label);
    button.type = "button";
    button.addEventListener("click", () => { state.filePage = page.id; openSettingsTab(); });
    tabs.append(button);
  }
}

function renderFileEditors(page) {
  const box = $("file-editors");
  box.replaceChildren();
  box.className = page.files.length > 1 ? "multi" : "";
  state.fileAreas = new Map();
  for (const file of page.files) {
    const section = element("div", "editor");
    if (file.title) section.append(element("h3", "", file.title));
    section.append(element("p", "hint", file.hint));
    const area = element("textarea", "file-text");
    area.spellcheck = false;
    section.append(area);
    box.append(section);
    state.fileAreas.set(file.name, area);
  }
  for (const file of page.files) send({ type: "get_file", name: file.name });
}

function openSettingsTab() {
  const tab = SETTINGS_TABS.find((item) => item.id === state.settingsTab);
  renderSettingsTabs();
  $("settings-result").textContent = "";
  $("settings-form").hidden = !tab.sections;
  $("settings-editor").hidden = !!tab.sections;
  $("file-tabs").hidden = !tab.pages;
  $("file-editors").hidden = !tab.pages;
  $("settings-text").hidden = !!tab.pages;
  $("settings-hint").hidden = !!tab.pages;
  if (tab.sections) {
    renderSettingsForm();
    if (!state.settings) send({ type: "get_settings" });
    return;
  }
  $("settings-text").value = "";
  if (tab.pages) {
    renderFileTabs();
    renderFileEditors(FILE_PAGES.find((page) => page.id === state.filePage));
  } else {
    $("settings-hint").textContent = YAML_HINT;
    send({ type: "get_config" });
  }
}

function saveSettings() {
  const tab = SETTINGS_TABS.find((item) => item.id === state.settingsTab);
  $("settings-result").textContent = "Saving…";
  $("settings-result").className = "";
  if (tab.sections) {
    if (!state.settings) return;
    const patch = buildPatch(state.settings);
    if (!Object.keys(patch.set).length && !patch.unset.length) { showSaved(true, "No changes"); return; }
    send({ type: "save_settings", ...patch });
  } else if (tab.pages) {
    const page = FILE_PAGES.find((item) => item.id === state.filePage);
    state.pendingSaves = page.files.length;
    state.saveWarnings = [];
    for (const file of page.files) send({ type: "save_file", name: file.name, text: state.fileAreas.get(file.name).value });
  } else {
    send({ type: "save_config", text: $("settings-text").value });
  }
}

function showChat() {
  $("settings").hidden = true;
  $("chat").hidden = false;
}

function showSettings() {
  state.settings = null;
  closeDrawer();
  $("chat").hidden = true;
  $("settings").hidden = false;
  openSettingsTab();
}

/* ---------- Misc ---------- */

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
  if (event.key !== "Enter" || event.isComposing) return;
  // On touch screens Enter starts a new line and the send button sends.
  if (event.ctrlKey || event.metaKey || (!event.shiftKey && !isTouchDevice())) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

function isTouchDevice() {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

$("input").addEventListener("input", autoGrow);
$("stop").addEventListener("click", () => {
  if (state.currentId) send({ type: "stop", sessionId: state.currentId });
});
$("new-session").addEventListener("click", createSession);
$("topbar-new").addEventListener("click", createSession);
$("menu").addEventListener("click", openDrawer);
$("scrim").addEventListener("click", closeDrawer);
$("theme").addEventListener("click", cycleTheme);
$("open-settings").addEventListener("click", showSettings);
$("close-settings").addEventListener("click", showChat);
$("save-settings").addEventListener("click", saveSettings);

applyTheme(currentTheme());
renderSettingsTabs();
$("input").placeholder = isTouchDevice() ? "Say something…" : "Say something… (Enter sends, Shift+Enter adds a line)";
setInterval(() => { if (!document.hidden) send({ type: "get_status" }); }, 20000);

connect();
