// @ts-check
/** @typedef {import("../../protocol/messages.js").ClientMessage} ClientMessage */
/** @typedef {import("../../protocol/messages.js").ServerMessage} ServerMessage */
/** @typedef {Extract<ClientMessage, { type: "save_schedule" }>} ScheduleMessage */
/** @typedef {Extract<ClientMessage, { type: "approve" }>["answer"]} ApprovalAnswer */

import { addNotice, applyEvent, createSession, ensureCurrentSession, renderApprovals, renderHistory, renderSessions, renderTasks, renderTriggers, selectSession, setOpenTrace, setShowChat, setBusy } from "./chat.js";
import { isFormTab, makeSettings, openSettingsTab, renderNotes, renderSettingsForm, renderSettingsTabs, saveSettings, updateWechatStatus, WECHAT_LABELS } from "./settings.js";
import { applyTraceEvent, leaveTraces, loadTraces, receiveTrace, receiveTraces, renderTraceDetail, renderTraceList, requestTrace, selectTrace, showTraces } from "./traces.js";
import { renderMarkdown } from "./markdown.js";
import { send, connect } from "./net.js";
import { renderSchedules } from "./schedules.js";
import { state } from "./state.js";
import { $, $field, closeDrawer, element, flash, openDrawer, pad2, savedMessage, setStatus, showSaved } from "./ui.js";

/** @param {ServerMessage} msg */
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
    case "tasks":
      state.tasks = msg.tasks;
      renderTasks();
      break;
    case "triggers":
      state.triggers = msg.triggers;
      renderTriggers();
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
    case "schedules":
      state.schedules = msg;
      if (state.settingsTab === "schedules") renderSchedules();
      break;
    case "schedule_saved":
      if (msg.ok) { state.editingSchedule = null; showSaved(true, "Saved"); }
      else showSaved(false, "", msg.error);
      break;
    case "config":
      if (state.settingsTab === "yaml" && state.configBase === undefined) {
        $field("settings-text").value = msg.text;
        $field("settings-text").disabled = false;
        state.configBase = msg.text;
      }
      break;
    case "file":
      if (state.fileAreas.has(msg.name) && !state.fileBases.has(msg.name)) {
        state.fileAreas.get(msg.name).value = msg.text;
        state.fileAreas.get(msg.name).disabled = false;
        state.fileBases.set(msg.name, msg.text);
      }
      break;
    case "notes":
      renderNotes(msg.names);
      break;
    case "config_saved":
      if (msg.ok && state.savingConfig !== undefined) state.configBase = state.savingConfig;
      state.savingConfig = undefined;
      showSaved(msg.ok, savedMessage(msg.restarting, true), msg.error);
      break;
    case "file_saved":
      if (state.fileAreas.has(msg.name)) {
        if (!msg.ok) { state.pendingSaves = 0; showSaved(false, "", msg.error); break; }
        if (state.savingFiles.has(msg.name)) state.fileBases.set(msg.name, state.savingFiles.get(msg.name));
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
    case "traces":
      receiveTraces(msg);
      break;
    case "trace":
      receiveTrace(msg);
      break;
    case "trace_event":
      applyTraceEvent(msg.summary, msg.event);
      break;
    case "error":
      state.loadingHistory = false;
      if (state.historyButton) state.historyButton.disabled = false;
      flash(msg.message);
      break;
  }
}

/* ---------- Status line, drawer and theme ---------- */

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

function showChat() {
  leaveTraces();
  $("settings").hidden = true;
  $("chat").hidden = false;
}

function showSettings() {
  state.settings = null;
  closeDrawer();
  leaveTraces();
  $("chat").hidden = true;
  $("settings").hidden = false;
  openSettingsTab();
}

function autoGrow() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $field("input");
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
    /** @type {HTMLFormElement} */ ($("composer")).requestSubmit();
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
$("open-traces").addEventListener("click", showTraces);
$("close-traces").addEventListener("click", showChat);
$("trace-search").addEventListener("input", () => {
  clearTimeout(state.traces.searchTimer);
  state.traces.searchTimer = setTimeout(() => {
    state.traces.query = $field("trace-search").value.trim();
    state.traces.runs = [];
    state.traces.nextBefore = undefined;
    loadTraces();
    renderTraceDetail();
  }, 300);
});
$("trace-source").addEventListener("change", () => { state.traces.source = $field("trace-source").value; renderTraceList(); });
$("trace-errors").addEventListener("change", () => { state.traces.errorsOnly = $field("trace-errors").checked; renderTraceList(); });

applyTheme(currentTheme());
renderSettingsTabs();
$field("input").placeholder = isTouchDevice() ? "Say something…" : "Say something… (Enter sends, Shift+Enter adds a line)";
setInterval(() => { if (!document.hidden) send({ type: "get_status" }); }, 20000);

// Everything the open page needs after a (re)connection: resubscribe and reload.
function onSocketOpen() {
  if (state.currentId) send({ type: "open", sessionId: state.currentId });
  send({ type: "get_status" });
  if (!$("settings").hidden && isFormTab(state.settingsTab)) send({ type: "get_settings" });
  if (!$("traces").hidden) {
    send({ type: "watch_traces", on: true });
    loadTraces();
    if (state.traces.selected) requestTrace(state.traces.selected);
  }
}

// The trace viewer is opened from a background task's Trace action.
setOpenTrace((id) => { showTraces(); selectTrace(id); });
// Selecting a session from the drawer returns the UI to the chat page.
setShowChat(() => showChat());

connect(handle, onSocketOpen);
