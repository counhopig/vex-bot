import { describe, expect, it, vi } from "vitest";
import { createTraceQueryTool } from "../src/tools/traceQuery.js";
import { createWatchdogReportTool, type WatchdogOutcome } from "../src/tools/watchdog.js";
import type { TraceEvent, TraceSummary } from "../src/trace/types.js";
import { anomaliesSince, createWatchdog, isAnomaly, watchdogPrompt } from "../src/trace/watchdog.js";

const HOUR = 3_600_000;

function run(id: string, overrides: Partial<TraceSummary> = {}): TraceSummary {
  return { id, session: "wechat", source: "owner", model: "faux/m", title: id, startedAt: 10 * HOUR, endedAt: 10 * HOUR + 1000, ms: 1000, outcome: "ok", llmCalls: 1, toolCalls: 0, toolErrors: 0, input: 0, output: 0, ...overrides };
}

/** A store whose runs are listed newest first, two per page. */
function store(runs: TraceSummary[], events: Record<string, TraceEvent[]> = {}) {
  return {
    list: vi.fn(async ({ before }: { before?: string; limit?: number; query?: string } = {}) => {
      const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
      const start = before ? Number(before) : 0;
      const page = sorted.slice(start, start + 2);
      return { runs: page, ...(start + 2 < sorted.length ? { nextBefore: String(start + 2) } : {}) };
    }),
    read: async (id: string) => events[id] ?? [],
    summary: (id: string) => runs.find((item) => item.id === id),
  };
}

describe("watchdog", () => {
  it("counts failures, interruptions and undelivered replies, but never its own runs", () => {
    expect(isAnomaly(run("a", { outcome: "error" }))).toBe(true);
    expect(isAnomaly(run("b", { outcome: "interrupted" }))).toBe(true);
    expect(isAnomaly(run("c", { delivered: false }))).toBe(true);
    expect(isAnomaly(run("d", { outcome: "stopped" }))).toBe(false);
    expect(isAnomaly(run("e", { source: "watchdog", outcome: "error" }))).toBe(false);
  });

  it("collects anomalies that ended inside the window across pages", async () => {
    const traces = store([
      run("new-error", { startedAt: 12 * HOUR, endedAt: 12 * HOUR + 1, outcome: "error", error: "provider down" }),
      run("new-ok", { startedAt: 11 * HOUR + 2, endedAt: 11 * HOUR + 3 }),
      run("long", { startedAt: 9 * HOUR, endedAt: 11 * HOUR + 5, outcome: "error" }),
      run("old-error", { startedAt: 8 * HOUR, endedAt: 8 * HOUR + 1, outcome: "error" }),
    ]);
    expect((await anomaliesSince(traces, 11 * HOUR)).map((item) => item.id)).toEqual(["new-error", "long"]);
  });

  it("calls the model only when there are anomalies, then moves its window on", async () => {
    let now = 12 * HOUR;
    const runs = [run("quiet", { startedAt: 11.5 * HOUR, endedAt: 11.5 * HOUR + 1 })];
    const model = vi.fn(async (_prompt: string, _signal: AbortSignal) => "定时任务没发出去");
    const deliver = vi.fn(async () => {});
    const check = createWatchdog({ traces: store(runs), everyMs: HOUR, run: model, deliver, now: () => now });
    await check(new AbortController().signal);
    expect(model).not.toHaveBeenCalled();

    runs.push(run("failed", { startedAt: 12.5 * HOUR, endedAt: 12.5 * HOUR + 1, source: "scheduled task", delivered: false, error: "no context token" }));
    now = 13 * HOUR;
    await check(new AbortController().signal);
    expect(model).toHaveBeenCalledOnce();
    expect(model.mock.calls[0]![0]).toContain("failed · 1970-01-01T12:30:00.000Z · session wechat · source scheduled task · ok · error: no context token · WeChat delivery failed");
    expect(deliver).toHaveBeenCalledWith("定时任务没发出去", expect.any(AbortSignal));

    now = 14 * HOUR;
    await check(new AbortController().signal);
    expect(model).toHaveBeenCalledOnce();
  });

  it("records the runs it would have looked into when the source is set to record only", async () => {
    let now = 12 * HOUR;
    const runs = [run("failed", { startedAt: 11.5 * HOUR, endedAt: 11.5 * HOUR + 1, outcome: "error", error: "provider down" })];
    const model = vi.fn(async () => "通知");
    const admit = vi.fn(() => false);
    const check = createWatchdog({ traces: store(runs), everyMs: HOUR, run: model, deliver: vi.fn(), admit, now: () => now });
    await check(new AbortController().signal);
    expect(model).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledWith({ source: "watchdog", title: "Watchdog check", text: expect.stringContaining("failed") });

    // The window moves on, so a later check does not offer the same runs again.
    now = 13 * HOUR;
    await check(new AbortController().signal);
    expect(admit).toHaveBeenCalledOnce();
  });

  it("keeps the window when the model check fails, so the next check sees the same runs", async () => {    let now = 12 * HOUR;
    const traces = store([run("failed", { startedAt: 11.5 * HOUR, endedAt: 11.5 * HOUR + 1, outcome: "error" })]);
    const model = vi.fn().mockRejectedValueOnce(new Error("provider down")).mockResolvedValueOnce(null);
    const check = createWatchdog({ traces, everyMs: HOUR, run: model, deliver: vi.fn(), now: () => now });
    await expect(check(new AbortController().signal)).rejects.toThrow("provider down");
    now = 13 * HOUR;
    await check(new AbortController().signal);
    expect(model).toHaveBeenCalledTimes(2);
    expect(model.mock.calls[1]![0]).toContain("failed");
  });

  it("caps the runs shown to the model", () => {
    const prompt = watchdogPrompt(Array.from({ length: 25 }, (_, index) => run(`r${index}`, { outcome: "error" })));
    expect(prompt).toContain("(5 more not shown)");
    expect(prompt).toContain("watchdog_report");
  });

  it("reports through a typed tool and requires a message to notify", async () => {
    const outcome: WatchdogOutcome = {};
    const tool = createWatchdogReportTool(outcome);
    await expect(tool.execute("1", { notify: true })).rejects.toThrow("message is required");
    await tool.execute("2", { notify: true, message: " 心跳连续失败 " });
    expect(outcome).toEqual({ notify: true, message: "心跳连续失败" });
    await tool.execute("3", { notify: false });
    expect(outcome).toEqual({ notify: false });
  });
});

describe("trace_query tool", () => {
  const textOf = (result: { content: ({ type: string; text?: string })[] }) => result.content[0]?.text ?? "";

  it("lists runs filtered by source and failure", async () => {
    const tool = createTraceQueryTool(store([
      run("ok-run", { startedAt: 3 * HOUR }),
      run("bad-run", { startedAt: 2 * HOUR, source: "heartbeat", outcome: "error", error: "timeout" }),
      run("tool-run", { startedAt: 1 * HOUR, toolErrors: 2 }),
    ]));
    expect(textOf(await tool.execute("1", { action: "list", errorsOnly: true })).split("\n").map((line) => line.split(" · ")[0])).toEqual(["bad-run", "tool-run"]);
    const heartbeat = textOf(await tool.execute("2", { action: "list", source: "heartbeat" }));
    expect(heartbeat).toContain("bad-run");
    expect(heartbeat).toContain("error: timeout");
    expect(textOf(await tool.execute("3", { action: "list", source: "wiki" }))).toBe("No matching runs.");
  });

  it("reads a run as condensed steps", async () => {
    const tool = createTraceQueryTool(store([run("r1", { outcome: "error" })], { r1: [
      { t: 0, type: "run_start", id: "r1", session: "wechat", source: "scheduled task", model: "faux/m", text: "search news" },
      { t: 1, type: "llm_start", id: "l1", model: "faux/m", context: { system: 1, tools: 1, conversation: 1, messages: 1, total: 3 }, system: "SYSTEM PROMPT" },
      { t: 2, type: "llm_end", id: "l1", ms: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", toolCalls: [{ id: "c1", name: "web_search" }] },
      { t: 3, type: "tool_start", id: "c1", name: "web_search", args: "{\"query\":\"news\"}" },
      { t: 4, type: "tool_end", id: "c1", name: "web_search", ms: 1, isError: true, result: "no search service" },
      { t: 5, type: "run_end", ms: 5, outcome: "error", error: "provider down" },
    ] }));
    const text = textOf(await tool.execute("1", { action: "read", id: "r1" }));
    expect(text).toContain("start wechat (scheduled task, faux/m): search news");
    expect(text).toContain("model toolUse → web_search");
    expect(text).toContain("failed web_search (1ms): no search service");
    expect(text).toContain("end error (5ms): provider down");
    expect(text).not.toContain("SYSTEM PROMPT");
    await expect(tool.execute("2", { action: "read", id: "missing" })).rejects.toThrow("No such run");
  });
});
