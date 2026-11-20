// @ts-check
/** @typedef {import("../../protocol/messages.js").ClientMessage} ClientMessage */
/** @typedef {Extract<ClientMessage, { type: "save_schedule" }>} ScheduleMessage */

import { send } from "./net.js";
import { state } from "./state.js";
import { $, $field, element, pad2, showSaved } from "./ui.js";

const RULE_HINTS = {
  cron: "Five fields: minute hour day month weekday. 0 9 * * * is every day at 09:00; 30 22 * * 1-5 is weekdays at 22:30.",
  every: "A number followed by s, m, h or d, such as 30m or 2h.",
  once: "A single date and time, in this browser's time zone.",
};


function localInput(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** A readable form of a schedule rule. */
function describeRule(rule) {
  if (rule.every) return `Every ${rule.every}`;
  if (rule.once) return `Once, ${new Date(rule.once).toLocaleString()}`;
  const fields = String(rule.cron).trim().split(/\s+/);
  if (fields.length === 5 && /^\d+$/.test(fields[0]) && /^\d+$/.test(fields[1]) && fields[2] === "*" && fields[3] === "*") {
    const time = `${pad2(fields[1])}:${pad2(fields[0])}`;
    if (fields[4] === "*") return `Every day at ${time}`;
    if (fields[4] === "1-5") return `Weekdays at ${time}`;
    if (fields[4] === "0,6" || fields[4] === "6,0") return `Weekends at ${time}`;
  }
  return `Cron ${rule.cron}`;
}

function targetLabel(id) {
  return state.schedules?.targets.find((target) => target.id === id)?.label ?? id;
}

/** @returns {ScheduleMessage} */
function scheduleMessage(task, changes = {}) {
  return { type: "save_schedule", id: task.id, name: task.name, prompt: task.prompt, target: task.target, enabled: task.enabled, schedule: task.schedule, ...changes };
}

export function renderScheduleForm(box) {
  const draft = state.editingSchedule;
  const kind = draft.kind;
  const form = element("div", "section");
  form.append(element("h3", "", draft.id ? `Edit "${draft.name}"` : "New scheduled task"));
  const field = (label, control, help) => {
    const wrap = element("div", "field");
    const caption = element("label", "", label);
    caption.htmlFor = control.id;
    wrap.append(caption, control);
    if (help) wrap.append(element("p", "help", help));
    form.append(wrap);
  };
  const name = element("input");
  name.type = "text"; name.id = "schedule-name"; name.value = draft.name;
  name.addEventListener("input", () => { draft.name = name.value; });
  field("Name", name);
  const type = element("select");
  type.id = "schedule-kind";
  for (const [value, label] of [["cron", "Repeating (cron)"], ["every", "Every interval"], ["once", "Once"]]) {
    const option = element("option", "", label);
    option.value = value;
    type.append(option);
  }
  type.value = kind;
  type.addEventListener("change", () => { draft.kind = type.value; draft.value = ""; renderSchedules(); });
  field("Repeat", type);
  const value = element("input");
  value.id = "schedule-value";
  value.type = kind === "once" ? "datetime-local" : "text";
  value.value = draft.value;
  if (kind === "cron") value.placeholder = "0 9 * * *";
  if (kind === "every") value.placeholder = "30m";
  value.addEventListener("input", () => { draft.value = value.value; });
  field(kind === "once" ? "Time" : kind === "every" ? "Interval" : "Cron rule", value, RULE_HINTS[kind]);
  const target = element("select");
  target.id = "schedule-target";
  for (const option of state.schedules?.targets ?? [{ id: "wechat", label: "WeChat" }]) {
    const item = element("option", "", option.label);
    item.value = option.id;
    target.append(item);
  }
  if (!state.schedules?.targets.some((option) => option.id === draft.target)) {
    const item = element("option", "", draft.target);
    item.value = draft.target;
    target.append(item);
  }
  target.value = draft.target;
  target.addEventListener("change", () => { draft.target = target.value; });
  field("Deliver to", target);
  const prompt = element("textarea", "file-text");
  prompt.id = "schedule-prompt";
  prompt.value = draft.prompt;
  prompt.addEventListener("input", () => { draft.prompt = prompt.value; });
  field("Instruction", prompt, "Vex receives this at the set time and acts on it with all its tools, for example: search today's AI news and summarise the top five.");
  const actions = element("div", "settings-actions");
  const save = element("button", "", "Save task");
  save.type = "button";
  save.addEventListener("click", () => {
    let ruleValue = draft.value.trim();
    if (draft.kind === "once") {
      const date = new Date(ruleValue);
      if (!ruleValue || Number.isNaN(date.getTime())) { showSaved(false, "", "Choose a date and time"); return; }
      ruleValue = date.toISOString();
    }
    if (!draft.name.trim() || !draft.prompt.trim() || !ruleValue) { showSaved(false, "", "Name, repeat rule and instruction are required"); return; }
    $("settings-result").textContent = "Saving…";
    $("settings-result").className = "";
    send({ type: "save_schedule", ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), prompt: draft.prompt.trim(), target: draft.target, enabled: draft.enabled, schedule: /** @type {ScheduleMessage["schedule"]} */ ({ [draft.kind]: ruleValue }) });
  });
  const cancel = element("button", "secondary", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => { state.editingSchedule = null; renderSchedules(); });
  actions.append(save, cancel);
  form.append(actions);
  box.append(form);
}

export function editSchedule(task) {
  const kind = task ? Object.keys(task.schedule)[0] : "cron";
  const raw = task ? task.schedule[kind] : "";
  state.editingSchedule = task
    ? { id: task.id, name: task.name, prompt: task.prompt, target: task.target, enabled: task.enabled, kind, value: kind === "once" ? localInput(raw) : raw }
    : { name: "", prompt: "", target: "wechat", enabled: true, kind: "cron", value: "" };
  $("settings-result").textContent = "";
  renderSchedules();
}

export function renderSchedules() {
  const box = $("schedule-list");
  box.replaceChildren();
  if (!state.schedules) { box.append(element("p", "hint", "Loading…")); return; }
  const head = element("div", "schedule-head");
  head.append(element("p", "hint", "Tasks deliver an instruction to a conversation at set times; Vex acts on it like a message from you. You can also manage them by asking Vex in chat."));
  const add = element("button", "", "New task");
  add.type = "button";
  add.addEventListener("click", () => editSchedule(null));
  head.append(add);
  box.append(head);
  if (state.editingSchedule) renderScheduleForm(box);
  if (!state.schedules.tasks.length) box.append(element("p", "hint", "No scheduled tasks yet."));
  for (const task of state.schedules.tasks) {
    const card = element("div", `section task${task.enabled ? "" : " off"}`);
    const title = element("div", "task-title");
    title.append(element("h3", "", task.name), element("span", `badge${task.enabled ? " on" : ""}`, task.enabled ? "On" : "Off"));
    card.append(title);
    const next = task.enabled && task.nextAt ? `Next: ${new Date(task.nextAt).toLocaleString()}` : "Not scheduled";
    card.append(element("p", "hint", `${describeRule(task.schedule)} · ${next} · To ${targetLabel(task.target)}`));
    card.append(element("p", "task-prompt", task.prompt));
    const actions = element("div", "task-actions");
    const toggle = element("button", "secondary", task.enabled ? "Pause" : "Resume");
    toggle.type = "button";
    toggle.addEventListener("click", () => send(scheduleMessage(task, { enabled: !task.enabled })));
    const edit = element("button", "secondary", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => editSchedule(task));
    const remove = element("button", "danger", "Delete");
    remove.type = "button";
    remove.addEventListener("click", () => {
      if (confirm(`Delete the scheduled task "${task.name}"?`)) send({ type: "delete_schedule", id: task.id });
    });
    actions.append(toggle, edit, remove);
    card.append(actions);
    box.append(card);
  }
}
