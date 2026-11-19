// @ts-check

export const WECHAT_LABELS = { connected: "WeChat connected", connecting: "WeChat connecting", unlinked: "WeChat not linked", expired: "WeChat expired", disabled: "WeChat off" };

import { send } from "./net.js";
import { renderSchedules } from "./schedules.js";
import { state } from "./state.js";
import { $, $field, element, savedMessage, showSaved } from "./ui.js";


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

export const SETTINGS_TABS = [
  { id: "model", label: "Model", sections: [{ title: "Main model", fields: MODEL_FIELDS }, { title: "Background model", fields: BACKGROUND_FIELDS }, { title: "Link intent (Jev)", fields: [
    { path: "jev.enabled", label: "Enable Jev", type: "bool", help: "Use TypeSafe to classify whether a shared link should be archived, only read, or left alone. Permission approvals still apply." },
    { path: "jev.apiKey", label: "TypeSafe API Key", type: "secret" },
    { path: "jev.model", label: "Model", type: "text", help: "Defaults to jev-latest." },
    { path: "jev.confidence", label: "Decision threshold", type: "number", min: 0.5, max: 1, step: 0.01, help: "Between 0.5 and 1; defaults to 0.8." },
    { path: "jev.timeoutMs", label: "Request timeout (ms)", type: "number", min: 100, max: 30000, step: 100, help: "Defaults to 5000." },
  ] }] },
  { id: "channel", label: "WeChat", sections: [{ title: "WeChat", status: true, fields: [
    { path: "wechat.enabled", label: "Enable WeChat", type: "bool", help: "When off, vexd does not connect to WeChat." },
    { path: "wechat.ownerId", label: "Owner's WeChat id", type: "text", help: "Leave empty to use the account that scanned the QR code. Only the owner's messages are answered." },
  ] }] },
  { id: "voice", label: "Voice & links", sections: [
    { title: "Speech to text", fields: [
      { path: "stt.provider", label: "Service type", type: "select", options: ["", "mimo"], rerender: true, labels: { "": "OpenAI compatible (/audio/transcriptions)", mimo: "Xiaomi MiMo" }, help: "Bilibili and YouTube videos without subtitles are transcribed with this service." },
      { path: "stt.baseUrl", label: "Service address", type: "text", placeholder: (draft) => draft["stt.provider"] === "mimo" ? "https://api.xiaomimimo.com/v1" : "https://api.openai.com/v1" },
      { path: "stt.model", label: "Model", type: "text", placeholder: (draft) => draft["stt.provider"] === "mimo" ? "mimo-v2.5-asr" : "whisper-1" },
      { path: "stt.apiKey", label: "API Key", type: "secret" },
      { path: "stt.language", label: "Language hint", type: "text", placeholder: "zh" },
      { path: "stt.chunkMinutes", label: "Minutes per part", type: "number", min: 1, max: 30, help: "Lower it when the service limits the upload size; default 10. MiMo uses at most 15." },
      { path: "stt.maxMinutes", label: "Longest video (minutes)", type: "number", min: 1, max: 600, help: "Longer videos are not transcribed; default 90." },
    ] },
    { title: "Reading links", fields: [
      { path: "links.defaultIntent", label: "Shared links", type: "select", options: ["", "archive", "read"], labels: { "": "Default (archive)", archive: "Archive into the wiki unless I say not to", read: "Only read them unless I ask to save" }, help: "Applies when the wiki is enabled; you can always say what to do with a particular link." },
      { path: "links.bilibili.sessdata", label: "Bilibili SESSDATA", type: "secret", help: "After signing in to bilibili.com, copy SESSDATA from the browser developer tools under Application → Cookies. Most subtitles need a login to read; it is as good as your login credential, so keep it safe. Takes effect as soon as it is saved." },
    ] },
    { title: "Web search", fields: [
      { path: "webSearch.provider", label: "Search service", type: "select", options: ["", "tavily", "searxng", "brave", "deepseek"], rerender: true, labels: { "": "Off", tavily: "Tavily (1000 free searches a month)", searxng: "SearXNG (self-hosted, free)", brave: "Brave Search (paid)", deepseek: "DeepSeek Search (paid)" } },
      { path: "webSearch.apiKey", label: "API Key", type: "secret", when: (draft) => ["tavily", "brave", "deepseek"].includes(draft["webSearch.provider"]), help: "The key for the chosen service; the environment variable TAVILY_API_KEY, BRAVE_API_KEY or DEEPSEEK_API_KEY also works." },
      { path: "webSearch.baseUrl", label: "SearXNG address", type: "text", placeholder: "http://searxng:8080", when: (draft) => draft["webSearch.provider"] === "searxng", help: "SearXNG must have the json format enabled in settings.yml; see the documentation for how to deploy it." },
    ] },
    { title: "Notes vault", fields: [
      { path: "vault.path", label: "Folder", type: "text", placeholder: "/vault", help: "A folder of Markdown notes (an Obsidian vault works) as vexd sees it; in Docker, mount it into the container first. Fill in either the folder or the git address; with a folder, leave the git address, branch, username and token empty. Vex only reads the notes." },
      { path: "vault.url", label: "Git address", type: "text", placeholder: "https://git.example.com/you/notes.git", help: "vexd keeps one copy of this repository and updates it when you ask about your notes; with the wiki on, the wiki writes into the same copy. Use an http or https address without a username or password in it." },
      { path: "vault.branch", label: "Branch", type: "text", placeholder: "Default branch" },
      { path: "vault.username", label: "Username", type: "text", help: "The account name your git host expects together with the token; some hosts accept any value." },
      { path: "vault.token", label: "Access token", type: "secret", help: "A read-only token is enough without the wiki; the wiki needs write access. Not needed to read a public repository." },
    ] },
    { title: "Wiki", fields: [
      { path: "vault.wiki.enabled", label: "Maintain a wiki", type: "bool", help: "Vex turns what it reads into linked wiki notes in the vault. Requires a git-backed vault. Takes effect after a restart." },
      { path: "vault.wiki.every", label: "Wiki interval", type: "text", placeholder: "6h", help: "How often the wiki is updated; a number followed by s, m, h or d, or a cron expression; default 6h." },
      { path: "vault.wiki.notify", label: "Notify about wiki updates", type: "bool", help: "Send a message when a wiki run changes notes." },
      { path: "vault.wiki.maxNotesPerRun", label: "Most notes per run", type: "number", min: 1, max: 200, help: "How many notes one wiki run may write; default 20." },
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
  { id: "schedules", label: "Schedules", schedules: true },
  { id: "yaml", label: "Advanced", yaml: true },
];

const FILE_PAGES = [
  { id: "soul", label: "Persona", files: [{ name: "SOUL.md", hint: "Persona, tone and rules of conduct. Takes effect from the next message." }] },
  { id: "user", label: "About me", files: [{ name: "USER.md", hint: "What it knows about you: how to address you, who you are, preferences and habits. Takes effect from the next message." }] },
  { id: "memory", label: "Memory", notes: true, files: [{ name: "MEMORY.md", title: "Long-term memory", hint: "Distilled long-term facts and decisions, kept under 100 lines. Takes effect from the next message." }] },
  { id: "heartbeat", label: "Heartbeat", files: [{ name: "HEARTBEAT.md", hint: "Checked at every heartbeat; write any instructions for the heartbeat here too. Leave it empty to skip the checks." }] },
];
const NOTES_HINT = "What Vex noted during conversations, one file per day. Every night the memory consolidation distils them into long-term memory.";
const YAML_HINT = "The full config.yaml. Change settings the forms do not cover (tool policy, MCP servers, the web token and so on) here; saving applies them automatically.";

export const isFormTab = (id) => !!SETTINGS_TABS.find((tab) => tab.id === id)?.sections;
const secretPath = (field, draft) => field.type === "secret" ? field.path : `providers.${draft[field.of]}.apiKey`;

export function makeSettings(msg) {
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
      // field.path only identifies the control; the draft holds real configuration paths.
      input.addEventListener("input", () => { draft[key] = input.value.trim(); });
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
      if (field.placeholder) input.placeholder = typeof field.placeholder === "function" ? field.placeholder(draft) : field.placeholder;
      input.addEventListener("input", () => { draft[field.path] = input.value.trim(); });
      wrap.append(label, input);
    }
  }
  if (field.help) wrap.append(element("p", "help", field.help));
  return wrap;
}

export function updateWechatStatus() {
  const hint = $("wechat-status");
  if (!hint) return;
  const info = state.statusInfo;
  hint.textContent = info ? `Status: ${WECHAT_LABELS[info.wechat] ?? info.wechat}. When WeChat is not linked or has expired, vexd shows a QR code in its log; scan it with WeChat on your phone, no restart needed.` : "Reading status…";
}

export function renderSettingsForm() {
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
  /** @type {Record<string, string | number | boolean | string[]>} */
  const set = {};
  /** @type {string[]} */
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

export function renderSettingsTabs() {
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

export function renderFileTabs() {
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
  box.className = page.files.length > 1 || page.notes ? "multi" : "";
  state.fileAreas = new Map();
  state.fileBases = new Map();
  state.notes = null;
  for (const file of page.files) {
    const section = element("div", "editor");
    if (file.title) section.append(element("h3", "", file.title));
    section.append(element("p", "hint", file.hint));
    const area = element("textarea", "file-text");
    area.spellcheck = false;
    area.disabled = true;
    section.append(area);
    box.append(section);
    state.fileAreas.set(file.name, area);
  }
  for (const file of page.files) send({ type: "get_file", name: file.name });
  if (page.notes) {
    const section = element("div", "editor");
    const select = element("select");
    select.id = "note-select";
    select.setAttribute("aria-label", "Daily note");
    const area = element("textarea", "file-text");
    area.spellcheck = false;
    area.disabled = true;
    const empty = element("p", "hint", "No daily notes yet.");
    select.hidden = area.hidden = empty.hidden = true;
    select.addEventListener("change", () => openNote(select.value));
    section.append(element("h3", "", "Daily notes"), element("p", "hint", NOTES_HINT), select, area, empty);
    box.append(section);
    state.notes = { select, area, empty, name: null };
    send({ type: "list_notes" });
  }
}

export function renderNotes(names) {
  if (!state.notes) return;
  const { select, area, empty } = state.notes;
  select.replaceChildren();
  for (const name of names) {
    const option = element("option", "", name.slice("memory/".length, -".md".length));
    option.value = name;
    select.append(option);
  }
  select.hidden = area.hidden = !names.length;
  empty.hidden = !!names.length;
  if (names.length) openNote(names[0]);
}

export function openNote(name) {
  const notes = state.notes;
  if (notes.name) { state.fileAreas.delete(notes.name); state.fileBases.delete(notes.name); }
  notes.name = name;
  notes.select.value = name;
  notes.area.value = "";
  notes.area.disabled = true;
  state.fileBases.delete(name);
  state.fileAreas.set(name, notes.area);
  send({ type: "get_file", name });
}

export function openSettingsTab() {
  const tab = SETTINGS_TABS.find((item) => item.id === state.settingsTab);
  renderSettingsTabs();
  $("settings-result").textContent = "";
  $("settings-form").hidden = !tab.sections;
  $("settings-editor").hidden = !!tab.sections || !!tab.schedules;
  $("schedule-list").hidden = !tab.schedules;
  $("save-settings").hidden = !!tab.schedules;
  if (tab.schedules) {
    state.editingSchedule = null;
    renderSchedules();
    send({ type: "get_schedules" });
    return;
  }
  $("file-tabs").hidden = !tab.pages;
  $("file-editors").hidden = !tab.pages;
  $("settings-text").hidden = !!tab.pages;
  $("settings-hint").hidden = !!tab.pages;
  if (tab.sections) {
    renderSettingsForm();
    if (!state.settings) send({ type: "get_settings" });
    return;
  }
  $field("settings-text").value = "";
  if (tab.pages) {
    renderFileTabs();
    renderFileEditors(FILE_PAGES.find((page) => page.id === state.filePage));
  } else {
    $("settings-hint").textContent = YAML_HINT;
    state.configBase = undefined;
    $field("settings-text").disabled = true;
    send({ type: "get_config" });
  }
}

export function saveSettings() {
  const tab = SETTINGS_TABS.find((item) => item.id === state.settingsTab);
  $("settings-result").textContent = "Saving…";
  $("settings-result").className = "";
  if (tab.sections) {
    if (!state.settings) return;
    const patch = buildPatch(state.settings);
    if (!Object.keys(patch.set).length && !patch.unset.length) { showSaved(true, "No changes"); return; }
    send({ type: "save_settings", ...patch });
  } else if (tab.pages) {
    if ([...state.fileAreas.keys()].some((name) => !state.fileBases.has(name))) {
      showSaved(false, "", "Wait for the files to finish loading");
      return;
    }
    state.pendingSaves = state.fileAreas.size;
    state.saveWarnings = [];
    state.savingFiles = new Map();
    for (const [name, area] of state.fileAreas) {
      state.savingFiles.set(name, area.value);
      const base = state.fileBases.get(name);
      send({ type: "save_file", name, text: area.value, ...(base === undefined ? {} : { base }) });
    }
  } else {
    if (state.configBase === undefined) { showSaved(false, "", "Wait for the configuration to finish loading"); return; }
    state.savingConfig = $field("settings-text").value;
    send({ type: "save_config", text: state.savingConfig, base: state.configBase });
  }
}
