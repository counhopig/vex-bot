import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler, type SchedulerHooks, type SchedulerOptions, type WikiBootstrapStatus } from "../src/scheduler/index.js";
import { createScheduleTool } from "../src/tools/schedule.js";

const dirs: string[] = [];
const schedulers: Scheduler[] = [];
afterEach(async () => { await Promise.all(schedulers.splice(0).map(s => s.close())); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture(extra: Partial<SchedulerOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "vex-scheduler-")); dirs.push(dataDir);
  const workspace = join(dataDir, "workspace"); await mkdir(workspace);
  let now = new Date(2026, 9, 3, 12).getTime();
  const hooks: SchedulerHooks = { deliver: vi.fn(async () => {}), targetExists: vi.fn(() => true), runTemporary: vi.fn(async () => "HEARTBEAT_OK"), deliverHeartbeat: vi.fn(async () => {}), checkOutreach: vi.fn(async () => {}), log: vi.fn() };
  const scheduler = new Scheduler({ dataDir, workspace, hooks, now: () => now, heartbeat: { every: "30m", activeHours: ["08:00", "22:00"] }, ...extra }); schedulers.push(scheduler);
  return { scheduler, dataDir, workspace, hooks, time: () => now, advance: (ms: number) => { now += ms; }, flush: async () => { await new Promise(resolve => setImmediate(resolve)); } };
}
describe("scheduler", () => {
  it("fires cron rules at their next deadline and leaves disabled tasks idle", async () => {
    const f = await fixture(); await f.scheduler.start();
    await f.scheduler.create({ name: "cron", prompt: "整点", target: "wechat", schedule: { cron: "1 * * * *" } });
    await f.scheduler.create({ name: "停用", prompt: "不发送", target: "wechat", schedule: { every: "1s" }, enabled: false });
    f.advance(59_000); await f.scheduler.tick(); await f.flush(); expect(f.hooks.deliver).not.toHaveBeenCalled();
    f.advance(1000); await f.scheduler.tick(); await f.flush(); expect(f.hooks.deliver).toHaveBeenCalledTimes(1);
    expect(f.hooks.deliver).toHaveBeenCalledWith("wechat", "[Scheduled task \"cron\"] 整点", "scheduled", expect.any(AbortSignal));
  });
  it("persists unique names and defaults tool targets to the source", async () => {
    const f = await fixture(); await f.scheduler.start();
    await createScheduleTool(f.scheduler, "web-one").execute("id", { action: "create", name: "提醒", prompt: "喝水", schedule: { every: "1m" } });
    expect(f.scheduler.list()[0]?.target).toBe("web-one");
    expect(createScheduleTool(f.scheduler, "web-one").description).toContain("handle with all your tools");
    await expect(f.scheduler.create({ name: "提醒", prompt: "重复", target: "wechat", schedule: { every: "1m" } })).rejects.toThrow("already exists");
    await f.scheduler.close();
    const restored = new Scheduler({ dataDir: f.dataDir, workspace: f.workspace, hooks: f.hooks, now: f.time }); schedulers.push(restored); await restored.start();
    expect(restored.list()).toHaveLength(1);
    expect(await restored.delete("提醒")).toBe(true); expect(restored.list()).toEqual([]);
  });
  it("delivers missed once tasks exactly once and falls back to WeChat", async () => {
    const f = await fixture();
    const dueAt = f.time() - 1000;
    await writeFile(join(f.dataDir, "schedules.json"), JSON.stringify([{ id: "1", name: "一次", prompt: "提醒", target: "deleted", enabled: true, schedule: { once: new Date(dueAt).toISOString() }, nextAt: dueAt }]));
    vi.mocked(f.hooks.targetExists).mockReturnValue(false);
    await f.scheduler.start(); await f.flush();
    expect(f.hooks.deliver).toHaveBeenCalledWith("wechat", "[Missed scheduled task \"一次\", originally due 2026-10-03 11:59] 提醒", "missed", expect.any(AbortSignal));
    expect(f.scheduler.list()[0]?.enabled).toBe(false);
    await f.scheduler.tick(); await f.flush(); expect(f.hooks.deliver).toHaveBeenCalledTimes(1);
  });
  it("updates a task in place: text, rule, target and pause or resume", async () => {
    const f = await fixture(); await f.scheduler.start();
    const task = await f.scheduler.create({ name: "news", prompt: "a", target: "wechat", schedule: { cron: "0 9 * * *" } });
    await f.scheduler.create({ name: "other", prompt: "b", target: "wechat", schedule: { every: "1h" } });
    const edited = await f.scheduler.update(task.id, { prompt: "search news", schedule: { cron: "30 13 * * *" }, target: "web-1" });
    expect(edited).toMatchObject({ id: task.id, name: "news", prompt: "search news", target: "web-1", nextAt: new Date(2026, 9, 3, 13, 30).getTime() });
    expect(f.scheduler.list().find((item) => item.id === task.id)?.prompt).toBe("search news");
    await expect(f.scheduler.update(task.id, { name: "other" })).rejects.toThrow("already exists");
    await expect(f.scheduler.update("missing", { prompt: "x" })).rejects.toThrow("No such scheduled task");
    expect((await f.scheduler.update(task.id, { enabled: false })).enabled).toBe(false);
    f.advance(2 * 3_600_000);
    expect((await f.scheduler.update(task.id, { enabled: true })).nextAt).toBe(new Date(2026, 9, 4, 13, 30).getTime());
    const restored = new Scheduler({ dataDir: f.dataDir, workspace: f.workspace, hooks: f.hooks, now: f.time }); schedulers.push(restored); await restored.start();
    expect(restored.list().find((item) => item.id === task.id)).toMatchObject({ prompt: "search news", enabled: true });
  });

  it("refuses to resume or move a one-time task into the past", async () => {
    const f = await fixture(); await f.scheduler.start();
    const once = await f.scheduler.create({ name: "once", prompt: "x", target: "wechat", schedule: { once: new Date(f.time() + 60_000).toISOString() } });
    await f.scheduler.update(once.id, { enabled: false });
    f.advance(120_000);
    await expect(f.scheduler.update(once.id, { enabled: true })).rejects.toThrow("in the past");
    await expect(f.scheduler.update(once.id, { schedule: { once: new Date(f.time() + 60_000).toISOString() }, enabled: true })).resolves.toMatchObject({ enabled: true });
  });

  it("moves missed recurring tasks to their next time without delivering", async () => {
    const f = await fixture();
    const dueAt = f.time() - 3_600_000;
    await writeFile(join(f.dataDir, "schedules.json"), JSON.stringify([{ id: "1", name: "每日", prompt: "早安", target: "wechat", enabled: true, schedule: { cron: "0 8 * * *" }, nextAt: dueAt }]));
    await f.scheduler.start(); await f.flush();
    expect(f.hooks.deliver).not.toHaveBeenCalled();
    expect(f.scheduler.list()[0]?.nextAt).toBe(new Date(2026, 9, 4, 8).getTime());
  });
  it("rejects one-shot times in the past", async () => {
    const f = await fixture(); await f.scheduler.start();
    await expect(f.scheduler.create({ name: "过期", prompt: "x", target: "wechat", schedule: { once: new Date(f.time() - 1000).toISOString() } })).rejects.toThrow("in the past");
  });
  it("sets a corrupt schedule file aside and starts with no tasks", async () => {
    const f = await fixture();
    await writeFile(join(f.dataDir, "schedules.json"), "not JSON");
    await f.scheduler.start();
    expect(f.scheduler.list()).toEqual([]);
    expect(f.hooks.log).toHaveBeenCalled();
    const kept = (await readdir(f.dataDir)).filter(name => name.startsWith("schedules.json.bad-"));
    expect(kept).toHaveLength(1);
    expect(await readFile(join(f.dataDir, kept[0]!), "utf8")).toBe("not JSON");
  });
  it("skips overlap while a turn is running, then permits the next trigger", async () => {
    const f = await fixture(); let finish!: () => void;
    vi.mocked(f.hooks.deliver).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.scheduler.start(); await f.scheduler.create({ name: "循环", prompt: "测试", target: "wechat", schedule: { every: "1s" } });
    f.advance(1000); await f.scheduler.tick(); await f.flush();
    f.advance(1000); await f.scheduler.tick(); await f.flush(); expect(f.hooks.deliver).toHaveBeenCalledTimes(1);
    finish(); await f.flush(); f.advance(1000); await f.scheduler.tick(); await f.flush(); expect(f.hooks.deliver).toHaveBeenCalledTimes(2);
  });
  it("skips blank heartbeats, silences OK and delivers useful results", async () => {
    const f = await fixture(); await f.scheduler.start();
    const settle = () => Promise.allSettled([...(f.scheduler as any).running.values()]);
    const beat = async () => { f.advance(30 * 60_000); await f.scheduler.tick(); await settle(); };
    await writeFile(join(f.workspace, "HEARTBEAT.md"), " \n"); await beat(); expect(f.hooks.runTemporary).not.toHaveBeenCalled();
    await writeFile(join(f.workspace, "HEARTBEAT.md"), "检查今天日程"); await beat();
    expect(f.hooks.runTemporary).toHaveBeenCalledTimes(1); expect(f.hooks.deliverHeartbeat).not.toHaveBeenCalled();
    vi.mocked(f.hooks.runTemporary).mockResolvedValue("今天有预约"); await beat();
    expect(f.hooks.deliverHeartbeat).toHaveBeenCalledWith("今天有预约", expect.any(AbortSignal));
    f.advance(10 * 3_600_000); await f.scheduler.tick(); await settle(); expect(f.hooks.runTemporary).toHaveBeenCalledTimes(2);
  });

  it("runs daily consolidation with seven dated notes and checks outreach", async () => {
    const f = await fixture(); await f.scheduler.start(); f.advance(15 * 3_600_000); await f.scheduler.tick();
    await vi.waitFor(() => expect(f.hooks.runTemporary).toHaveBeenCalledWith(expect.stringContaining("memory/2026-10-04.md"), "consolidation", expect.any(AbortSignal)));
    expect(vi.mocked(f.hooks.runTemporary).mock.calls[0]?.[0].match(/memory\/\d{4}-\d{2}-\d{2}\.md/g)).toHaveLength(7);
    expect(f.hooks.checkOutreach).toHaveBeenCalled();
  });
  it("bootstraps a pending wiki only after the backoff gate opens", async () => {
    const bootstrap = vi.fn<() => Promise<void>>(); let resolveBootstrap!: () => void;
    bootstrap.mockImplementation(() => new Promise<void>(resolve => { resolveBootstrap = resolve; }));
    let status: WikiBootstrapStatus = "pending"; let gate = 0;
    const f = await fixture({ wiki: { enabled: true, every: "6h", status: async () => status, nextAttemptAt: () => gate, bootstrap, run: vi.fn(async () => {}) } });
    gate = f.time() + 60_000;
    await f.scheduler.start(); await f.scheduler.tick(); await f.flush(); expect(bootstrap).not.toHaveBeenCalled();
    f.advance(59_000); await f.scheduler.tick(); await f.flush(); expect(bootstrap).not.toHaveBeenCalled();
    f.advance(1000); await f.scheduler.tick(); await f.flush(); expect(bootstrap).toHaveBeenCalledTimes(1);
    f.advance(60_000); await f.scheduler.tick(); await f.flush(); expect(bootstrap).toHaveBeenCalledTimes(1);
    resolveBootstrap(); await f.flush(); await f.flush();
  });
  it("does nothing while the wiki awaits review", async () => {
    const bootstrap = vi.fn(async () => {}); const run = vi.fn(async () => {});
    const f = await fixture({ wiki: { enabled: true, every: "6h", status: async () => "awaiting-review", nextAttemptAt: () => 0, bootstrap, run } });
    await f.scheduler.start(); f.advance(24 * 3_600_000); await f.scheduler.tick(); await f.flush();
    expect(bootstrap).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });
  it("runs a done wiki on its duration cadence only", async () => {
    const run = vi.fn(async () => {});
    const f = await fixture({ wiki: { enabled: true, every: "6h", status: async () => "done", nextAttemptAt: () => 0, bootstrap: vi.fn(async () => {}), run } });
    await f.scheduler.start(); await f.scheduler.tick(); await f.flush(); expect(run).not.toHaveBeenCalled();
    f.advance(6 * 3_600_000 - 1000); await f.scheduler.tick(); await f.flush(); expect(run).not.toHaveBeenCalled();
    f.advance(1000); await f.scheduler.tick(); await f.flush(); expect(run).toHaveBeenCalledTimes(1);
    f.advance(1000); await f.scheduler.tick(); await f.flush(); expect(run).toHaveBeenCalledTimes(1);
  });
  it("runs a done wiki on its cron cadence only", async () => {
    const run = vi.fn(async () => {});
    const f = await fixture({ wiki: { enabled: true, every: "0 4 * * *", status: async () => "done", nextAttemptAt: () => 0, bootstrap: vi.fn(async () => {}), run } });
    await f.scheduler.start(); await f.scheduler.tick(); await f.flush(); expect(run).not.toHaveBeenCalled();
    f.advance(16 * 3_600_000 - 1000); await f.scheduler.tick(); await f.flush(); expect(run).not.toHaveBeenCalled();
    f.advance(1000); await f.scheduler.tick(); await f.flush(); expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not retry a failing wiki run before the backoff gate advances", async () => {
    const run = vi.fn(async () => { throw new Error("wiki failed"); });
    let gate = 0;
    const f = await fixture({ wiki: { enabled: true, every: "6h", status: async () => "done", nextAttemptAt: () => gate, bootstrap: vi.fn(async () => {}), run } });
    await f.scheduler.start(); await f.scheduler.tick(); await f.flush();
    f.advance(6 * 3_600_000); await f.scheduler.tick(); await f.flush(); expect(run).toHaveBeenCalledTimes(1); expect(f.hooks.log).toHaveBeenCalled();
    gate = f.time() + 10 * 3_600_000;
    f.advance(6 * 3_600_000); await f.scheduler.tick(); await f.flush(); expect(run).toHaveBeenCalledTimes(1);
    f.advance(6 * 3_600_000); await f.scheduler.tick(); await f.flush(); expect(run).toHaveBeenCalledTimes(2);
  });
  it("logs asynchronous failures and aborts pending work on close", async () => {
    const f = await fixture(); await f.scheduler.start();
    vi.mocked(f.hooks.deliver).mockRejectedValueOnce(new Error("模型失败"));
    await f.scheduler.create({ name: "失败", prompt: "测试", target: "wechat", schedule: { every: "1s" } }); f.advance(1000); await f.scheduler.tick(); await f.flush(); expect(f.hooks.log).toHaveBeenCalled();
    vi.mocked(f.hooks.deliver).mockImplementation(async (_target, _prompt, _kind, signal) => { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); });
    f.advance(1000); await f.scheduler.tick(); await f.flush(); await f.scheduler.close(); f.advance(1000); await f.scheduler.tick(); expect(f.hooks.deliver).toHaveBeenCalledTimes(2);
  });
});
