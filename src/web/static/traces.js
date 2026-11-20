// @ts-check

import { sessionLabel } from "./chat.js";
import { send } from "./net.js";
import { state } from "./state.js";
import { $, $field, closeDrawer, element, pad2 } from "./ui.js";


const TRACE_RENDER_MS = 150;
const TRACE_SEARCH_MS = 300;

export function showTraces() {
  closeDrawer();
  $("chat").hidden = true;
  $("settings").hidden = true;
  $("traces").hidden = false;
  send({ type: "watch_traces", on: true });
  loadTraces();
  if (state.traces.selected) requestTrace(state.traces.selected);
  else renderTraceDetail();
}

export function leaveTraces() {
  if ($("traces").hidden) return;
  $("traces").hidden = true;
  send({ type: "watch_traces", on: false });
}

export function loadTraces(before) {
  const query = state.traces.query;
  send({ type: "list_traces", ...(before !== undefined ? { before } : {}), ...(query ? { query } : {}) });
}

export function requestTrace(id) {
  state.traces.events = null;
  state.traces.buffer = [];
  send({ type: "get_trace", id });
}

export function receiveTraces(msg) {
  const traces = state.traces;
  if ((msg.query ?? "") !== traces.query) return;
  if (msg.before !== undefined) {
    const known = new Set(traces.runs.map((run) => run.id));
    traces.runs = [...traces.runs, ...msg.runs.filter((run) => !known.has(run.id))];
  } else {
    traces.runs = msg.runs;
  }
  traces.nextBefore = msg.nextBefore;
  traces.loadingMore = false;
  renderTraceList();
}

export function receiveTrace(msg) {
  const traces = state.traces;
  if (msg.id !== traces.selected) return;
  // Events recorded while the file was being read arrive live as well; keep each once.
  const seen = new Set(msg.events.map((event) => JSON.stringify(event)));
  traces.events = [...msg.events, ...traces.buffer.filter((event) => !seen.has(JSON.stringify(event)))];
  traces.buffer = [];
  traces.summary = msg.summary;
  renderTraceDetail();
}

export function applyTraceEvent(summary, event) {
  const traces = state.traces;
  const index = traces.runs.findIndex((run) => run.id === summary.id);
  if (index >= 0) traces.runs[index] = summary;
  else if (!traces.query && event.type === "run_start") traces.runs.unshift(summary);
  const selected = summary.id === traces.selected;
  if (selected) {
    traces.summary = summary;
    if (traces.events) traces.events.push(event);
    else traces.buffer.push(event);
  }
  scheduleTraceRender(selected);
}

export function scheduleTraceRender(detail) {
  const traces = state.traces;
  traces.dirtyDetail = traces.dirtyDetail || detail;
  if (traces.renderTimer) return;
  traces.renderTimer = setTimeout(() => {
    traces.renderTimer = null;
    if ($("traces").hidden) return;
    renderTraceList();
    if (traces.dirtyDetail) renderTraceDetail();
    traces.dirtyDetail = false;
  }, TRACE_RENDER_MS);
}

export function selectTrace(id) {
  const traces = state.traces;
  traces.selected = id;
  traces.summary = traces.runs.find((run) => run.id === id) ?? null;
  traces.expanded = new Set();
  $("trace-panes").className = "detail";
  requestTrace(id);
  renderTraceList();
  renderTraceDetail();
}

function sourceLabel(source) {
  if (source === "owner") return "Message";
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${pad2(Math.round((ms % 60_000) / 1000))}s`;
}

function formatTokens(count) {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k` : String(count);
}

function formatClock(timestamp) {
  const date = new Date(timestamp);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return date.toDateString() === new Date().toDateString() ? time : `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}

function traceTone(run) {
  if (run.outcome === "running") return "running";
  if (run.outcome === "error" || run.outcome === "interrupted") return "error";
  if (run.outcome === "stopped") return "stopped";
  return run.toolErrors || run.delivered === false ? "warn" : "ok";
}

function isTraceFailure(run) {
  return run.outcome === "error" || run.outcome === "interrupted" || run.toolErrors > 0 || run.delivered === false;
}

function traceMeta(run) {
  return [
    run.outcome === "running" ? "running" : run.outcome === "interrupted" ? "interrupted" : formatDuration(run.ms ?? 0),
    `${run.llmCalls} LLM`,
    `${run.toolCalls} tools${run.toolErrors ? ` (${run.toolErrors} failed)` : ""}`,
    `${formatTokens(run.input)} → ${formatTokens(run.output)} tokens`,
    ...(run.delivered === false ? ["not delivered"] : []),
  ].join(" · ");
}

export function renderTraceSources() {
  const select = $field("trace-source");
  const sources = [...new Set(state.traces.runs.map((run) => run.source))].sort();
  if (state.traces.source && !sources.includes(state.traces.source)) sources.push(state.traces.source);
  const all = element("option", "", "All sources");
  all.value = "";
  select.replaceChildren(all, ...sources.map((source) => {
    const option = element("option", "", sourceLabel(source));
    option.value = source;
    return option;
  }));
  select.value = state.traces.source;
}

export function renderTraceList() {
  const traces = state.traces;
  renderTraceSources();
  const runs = traces.runs.filter((run) => (!traces.source || run.source === traces.source) && (!traces.errorsOnly || isTraceFailure(run)));
  const rows = runs.map((run) => {
    const row = element("button", `trace-run${run.id === traces.selected ? " active" : ""}`);
    row.type = "button";
    const head = element("div", "trace-run-head");
    head.append(element("span", `dot ${traceTone(run)}`), element("span", "trace-run-source", `${sessionLabel(run.session)} · ${sourceLabel(run.source)}`), element("span", "trace-run-time", formatClock(run.startedAt)));
    row.append(head, element("div", "trace-run-title", run.title || "(empty message)"), element("div", "trace-run-meta", traceMeta(run)));
    row.addEventListener("click", () => selectTrace(run.id));
    return row;
  });
  if (!rows.length) rows.push(element("p", "hint", traces.runs.length ? "No runs match." : "No runs recorded yet."));
  if (traces.nextBefore !== undefined) {
    const more = element("button", "secondary trace-more", "Load more");
    more.type = "button";
    more.disabled = traces.loadingMore;
    more.addEventListener("click", () => {
      if (traces.loadingMore) return;
      traces.loadingMore = true;
      more.disabled = true;
      loadTraces(traces.nextBefore);
    });
    rows.push(more);
  }
  $("trace-list").replaceChildren(...rows);
}

/** Turns a run's events into a tree of timed steps: tools under the model call that asked for them, a sub-agent's steps under its delegate call. */
function buildTrace(events, summary) {
  const steps = new Map();
  const roots = [];
  const owners = new Map();
  let start = summary?.startedAt ?? events[0]?.t ?? Date.now();
  let last = start;
  let ended = false;
  let llmCount = 0;
  const toolKey = (id) => `tool:${id}`;
  const add = (step, parentKey) => {
    steps.set(step.key, step);
    const parent = parentKey ? steps.get(parentKey) : undefined;
    if (parent) { step.depth = parent.depth + 1; parent.children.push(step); }
    else roots.push(step);
  };
  for (const event of events) {
    last = Math.max(last, event.t);
    switch (event.type) {
      case "run_start": start = event.t; break;
      case "run_end": ended = true; break;
      case "llm_start":
        add({ key: `llm:${event.id}`, kind: "llm", index: ++llmCount, start: event.t, end: null, depth: 0, children: [], begin: event, finish: null }, event.parent && toolKey(event.parent));
        break;
      case "llm_end": {
        const step = steps.get(`llm:${event.id}`);
        if (!step) break;
        step.end = event.t;
        step.finish = event;
        for (const call of event.toolCalls) owners.set(call.id, step.key);
        break;
      }
      case "tool_start":
        add({ key: toolKey(event.id), kind: "tool", start: event.t, end: null, depth: 0, children: [], begin: event, finish: null, gate: null }, owners.get(event.id) ?? (event.parent && toolKey(event.parent)));
        break;
      case "gate": {
        const step = steps.get(toolKey(event.id));
        if (step) step.gate = event;
        break;
      }
      case "tool_end": {
        const step = steps.get(toolKey(event.id));
        if (!step) break;
        step.end = event.t;
        step.finish = event;
        break;
      }
      default:
        add({ key: `event:${steps.size}`, kind: event.type, start: event.t, end: event.t, depth: 0, children: [], begin: event, finish: event }, event.parent && toolKey(event.parent));
    }
  }
  const finish = ended ? last : Math.max(last, Date.now());
  const all = [...steps.values()];
  const llm = all.filter((step) => step.kind === "llm" && step.finish);
  const tools = all.filter((step) => step.kind === "tool" && step.finish);
  const firstTokens = llm.flatMap((step) => step.finish.ttftMs === undefined ? [] : [step.finish.ttftMs]);
  return {
    start, finish, total: Math.max(finish - start, 1), roots, live: !ended,
    stats: {
      llmCalls: llm.length,
      toolCalls: tools.length,
      toolErrors: tools.filter((step) => step.finish.isError).length,
      modelMs: llm.reduce((sum, step) => sum + step.finish.ms, 0),
      toolMs: tools.reduce((sum, step) => sum + step.finish.ms, 0),
      firstTokenMs: firstTokens.length ? firstTokens.reduce((sum, ms) => sum + ms, 0) / firstTokens.length : undefined,
      input: llm.reduce((sum, step) => sum + step.finish.usage.input + step.finish.usage.cacheRead + step.finish.usage.cacheWrite, 0),
      output: llm.reduce((sum, step) => sum + step.finish.usage.output, 0),
    },
  };
}

function flattenSteps(steps) {
  return steps.flatMap((step) => [step, ...flattenSteps(step.children)]);
}

function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function argsPreview(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object") return Object.values(value).map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(" · ").replace(/\s+/g, " ").slice(0, 100);
  } catch {
    // Arguments cut to the trace limit are shown as written.
  }
  return text.replace(/\s+/g, " ").slice(0, 100);
}

function stepLabel(step) {
  const event = step.begin;
  switch (step.kind) {
    case "llm": {
      const model = event.model.slice(event.model.indexOf("/") + 1);
      const usage = step.finish ? `in ${formatTokens(step.finish.usage.input + step.finish.usage.cacheRead + step.finish.usage.cacheWrite)} / out ${formatTokens(step.finish.usage.output)}` : "generating";
      return { name: `LLM #${step.index}`, detail: `${model} · ${usage}`, tone: step.finish && (step.finish.stopReason === "error" || step.finish.stopReason === "aborted") ? "error" : "llm" };
    }
    case "tool":
      return { name: event.name, detail: argsPreview(event.args), tone: step.finish?.isError || step.gate?.blocked ? "error" : "tool" };
    case "user": return { name: "Message", detail: event.text, tone: "event" };
    case "compaction": return { name: "Compaction", detail: `${event.replaced} messages summarized`, tone: "event" };
    case "retry": return { name: "Retry", detail: `#${event.attempt} after ${formatDuration(event.delayMs)}: ${event.error}`, tone: "warn" };
    case "check": return { name: `Check · ${event.kind}`, detail: event.detail, tone: "warn" };
    case "delivery": return { name: "Delivery", detail: event.ok ? "sent to WeChat" : `failed: ${event.error ?? "unknown error"}`, tone: event.ok ? "event" : "error" };
    case "truncated": return { name: "Trace truncated", detail: `later steps over ${formatTokens(event.bytes)} bytes are not stored`, tone: "warn" };
    default: return { name: step.kind, detail: "", tone: "event" };
  }
}

function stepMatches(step, query) {
  return !!query && JSON.stringify([step.begin, step.finish, step.gate]).toLowerCase().includes(query.toLowerCase());
}

function traceField(label, value) {
  const row = element("div", "trace-field");
  row.append(element("span", "trace-field-label", label), element("span", "trace-field-value", value));
  return row;
}

function traceBlock(title, text, className = "") {
  const block = element("div", `trace-block ${className}`.trim());
  block.append(element("div", "trace-block-title", title), element("pre", "", text));
  return block;
}

function systemSections(text) {
  const sections = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("## ") || !sections.length) sections.push({ title: line.startsWith("## ") ? line.slice(3) : "Instructions", lines: [line] });
    else sections.at(-1).lines.push(line);
  }
  return sections.map((section) => ({ title: section.title, text: section.lines.join("\n") }));
}

function systemPromptBlock(step, model) {
  const traces = state.traces;
  const text = step.begin.system;
  if (text === undefined) {
    const earlier = flattenSteps(model.roots).filter((other) => other.kind === "llm" && other.start <= step.start && other !== step && other.begin.system !== undefined).at(-1);
    return element("p", "hint", earlier ? `System prompt unchanged since LLM #${earlier.index}.` : "System prompt unchanged.");
  }
  const block = element("div", "trace-block");
  block.append(element("div", "trace-block-title", `System prompt · ${text.length} chars`));
  systemSections(text).forEach((section, index) => {
    const key = `${step.key}:system:${index}`;
    const open = traces.expanded.has(key);
    const toggle = element("button", `trace-section${open ? " open" : ""}`, `${open ? "▾" : "▸"} ${section.title} · ${section.text.length} chars`);
    toggle.type = "button";
    toggle.addEventListener("click", (event) => {
      event.stopPropagation?.();
      if (traces.expanded.has(key)) traces.expanded.delete(key);
      else traces.expanded.add(key);
      renderTraceDetail();
    });
    block.append(toggle);
    if (open) block.append(element("pre", "", section.text));
  });
  return block;
}

function stepDetail(step, model) {
  const box = element("div", "trace-step-detail");
  const fields = element("div", "trace-fields");
  if (step.kind === "llm") {
    const context = step.begin.context;
    fields.append(traceField("Model", step.begin.model), traceField("Context", `${formatTokens(context.total)} tokens · system ${formatTokens(context.system)} · tools ${formatTokens(context.tools)} · conversation ${formatTokens(context.conversation)} (${context.messages} messages)`));
    if (step.finish) {
      const usage = step.finish.usage;
      fields.append(traceField("Duration", formatDuration(step.finish.ms)),
        traceField("First token", step.finish.ttftMs === undefined ? "–" : formatDuration(step.finish.ttftMs)),
        traceField("Stop reason", step.finish.stopReason),
        traceField("Tokens", `input ${usage.input} · output ${usage.output} · cache read ${usage.cacheRead} · cache write ${usage.cacheWrite}`));
    }
    box.append(fields);
    if (step.finish?.error) box.append(traceBlock("Error", step.finish.error, "error"));
    if (step.finish?.thinking) box.append(traceBlock("Thinking", step.finish.thinking));
    if (step.finish?.text) box.append(traceBlock("Reply", step.finish.text));
    if (step.finish?.toolCalls.length) box.append(traceField("Tool calls", step.finish.toolCalls.map((call) => call.name).join(", ")));
    box.append(systemPromptBlock(step, model));
    return box;
  }
  if (step.kind === "tool") {
    fields.append(traceField("Status", !step.finish ? "running" : step.finish.isError ? "failed" : "succeeded"));
    if (step.finish) fields.append(traceField("Duration", formatDuration(step.finish.ms)));
    if (step.gate) fields.append(traceField(step.gate.blocked ? "Blocked" : "Approval wait", step.gate.blocked ? `${step.gate.reason ?? "by policy"} (${formatDuration(step.gate.ms)})` : formatDuration(step.gate.ms)));
    box.append(fields, traceBlock("Arguments", prettyJson(step.begin.args)));
    if (step.finish) box.append(traceBlock("Result", step.finish.result || "(empty)", step.finish.isError ? "error" : ""));
    if (step.finish?.details) box.append(traceBlock("Details", prettyJson(step.finish.details)));
    return box;
  }
  const event = step.begin;
  const text = event.text ?? event.detail ?? event.error ?? "";
  box.append(traceField("Time", formatClock(event.t)));
  if (text) box.append(traceBlock(stepLabel(step).name, text, step.kind === "delivery" && !event.ok ? "error" : ""));
  return box;
}

function traceRows(model) {
  const traces = state.traces;
  const rows = [];
  const axis = element("div", "trace-axis");
  const ticks = element("div", "trace-track");
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const tick = element("span", "trace-tick", formatDuration(model.total * fraction));
    tick.style.left = `${fraction * 100}%`;
    ticks.append(tick);
  }
  axis.append(element("div", "trace-label"), ticks, element("span", "trace-dur"));
  rows.push(axis);
  for (const step of flattenSteps(model.roots)) {
    const label = stepLabel(step);
    const open = traces.expanded.has(step.key);
    const row = element("button", `trace-step tone-${label.tone}${open ? " open" : ""}${stepMatches(step, traces.query) ? " match" : ""}`);
    row.type = "button";
    const name = element("div", "trace-label");
    name.style.paddingLeft = `${8 + step.depth * 16}px`;
    name.append(element("span", "trace-name", label.name), element("span", "trace-sub", label.detail));
    const track = element("div", "trace-track");
    const end = step.end ?? model.finish;
    const bar = element("span", `trace-bar${step.end === step.start && step.kind !== "llm" && step.kind !== "tool" ? " instant" : ""}${step.end === null ? " live" : ""}`);
    bar.style.left = `${((step.start - model.start) / model.total) * 100}%`;
    bar.style.width = `${Math.max(((end - step.start) / model.total) * 100, 0.4)}%`;
    track.append(bar);
    const duration = step.kind === "llm" || step.kind === "tool" ? formatDuration((step.finish?.ms) ?? end - step.start) : "";
    row.append(name, track, element("span", "trace-dur", duration));
    row.addEventListener("click", () => {
      if (traces.expanded.has(step.key)) traces.expanded.delete(step.key);
      else traces.expanded.add(step.key);
      renderTraceDetail();
    });
    rows.push(row);
    if (open) rows.push(stepDetail(step, model));
  }
  return rows;
}

export function renderTraceDetail() {
  const traces = state.traces;
  const box = $("trace-detail");
  const back = element("button", "link trace-back", "← Runs");
  back.type = "button";
  back.addEventListener("click", () => { $("trace-panes").className = ""; });
  if (!traces.selected) { box.replaceChildren(element("p", "hint", "Select a run.")); return; }
  const summary = traces.summary ?? traces.runs.find((run) => run.id === traces.selected);
  if (!traces.events || !summary) { box.replaceChildren(back, element("p", "hint", "Loading…")); return; }
  const model = buildTrace(traces.events, summary);
  const head = element("div", "trace-head");
  const title = element("div", "trace-title");
  title.append(element("span", `dot ${traceTone(summary)}`), element("span", "", summary.title || "(empty message)"));
  head.append(title, element("div", "trace-run-meta", `${sessionLabel(summary.session)} · ${sourceLabel(summary.source)} · ${summary.model} · ${new Date(summary.startedAt).toLocaleString()}`));
  if (summary.error) head.append(element("pre", "trace-error", summary.error));
  const stats = element("div", "trace-stats");
  const { stats: s } = model;
  for (const [label, value] of [
    ["Duration", model.live ? `${formatDuration(model.total)}…` : formatDuration(summary.ms ?? model.total)],
    ["LLM calls", String(s.llmCalls)],
    ["Tool calls", s.toolErrors ? `${s.toolCalls} (${s.toolErrors} failed)` : String(s.toolCalls)],
    ["Model time", formatDuration(s.modelMs)],
    ["Tool time", formatDuration(s.toolMs)],
    ["First token", s.firstTokenMs === undefined ? "–" : formatDuration(s.firstTokenMs)],
    ["Tokens", `${formatTokens(s.input)} → ${formatTokens(s.output)}`],
  ]) {
    const stat = element("div", "trace-stat");
    stat.append(element("span", "trace-stat-value", value), element("span", "trace-stat-label", label));
    stats.append(stat);
  }
  const waterfall = element("div", "trace-waterfall");
  waterfall.append(...traceRows(model));
  box.replaceChildren(back, head, stats, waterfall);
  // A running run keeps its clock moving between events, such as during an approval wait.
  clearTimeout(traces.liveTimer);
  if (model.live && !$("traces").hidden) traces.liveTimer = setTimeout(renderTraceDetail, 1000);
}

/* ---------- Misc ---------- */
