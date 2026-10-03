import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler, type SchedulerHooks } from "../src/scheduler/index.js";
import { createScheduleTool } from "../src/tools/schedule.js";

const dirs: string[] = [];
const schedulers: Scheduler[] = [];
afterEach(async () => { await Promise.all(schedulers.splice(0).map(s => s.close())); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "vex-scheduler-")); dirs.push(dataDir);
  const workspace = join(dataDir, "workspace"); await mkdir(workspace);
  let now = new Date(2026, 9, 3, 12).getTime();
  const hooks: SchedulerHooks = { deliver: vi.fn(async () => {}), targetExists: vi.fn(() => true), runTemporary: vi.fn(async () => "HEARTBEAT_OK"), deliverHeartbeat: vi.fn(async () => {}), checkOutreach: vi.fn(async () => {}), log: vi.fn() };
  const scheduler = new Scheduler({ dataDir, workspace, hooks, now: () => now, heartbeat: { every: "30m", activeHours: ["08:00", "22:00"] } }); schedulers.push(scheduler);
  return { scheduler, dataDir, workspace, hooks, time: () => now, advance: (ms: number) => { now += ms; }, flush: async () => { await new Promise(resolve => setImmediate(resolve)); } };
}
describe("scheduler", () => {
  it("fires cron rules at their next deadline and leaves disabled tasks idle", async () => {
    const f = await fixture(); await f.scheduler.start();
    await f.scheduler.create({ name: "cron", prompt: "整点", target: "wechat", schedule: { cron: "1 * * * *" } });
    await f.scheduler.create({ name: "停用", prompt: "不发送", target: "wechat", schedule: { every: "1s" }, enabled: false });
    f.advance(59_000); await f.scheduler.tick(); await f.flush(); expect(f.hooks.deliver).not.toHaveBeenCalled();
    f.advance(1000); await f.scheduler.tick(); await f.flush(); expect(f.hooks.deliver).toHaveBeenCalledTimes(1);
    expect(f.hooks.deliver).toHaveBeenCalledWith("wechat", "整点", "scheduled", expect.any(AbortSignal));
  });
  it("persists unique names and defaults tool targets to the source", async () => {
    const f = await fixture(); await f.scheduler.start();
    await createScheduleTool(f.scheduler, "web-one").execute("id", { action: "create", name: "提醒", prompt: "喝水", schedule: { every: "1m" } });
    expect(f.scheduler.list()[0]?.target).toBe("web-one");
    await expect(f.scheduler.create({ name: "提醒", prompt: "重复", target: "wechat", schedule: { every: "1m" } })).rejects.toThrow("已存在");
    await f.scheduler.close();
    const restored = new Scheduler({ dataDir: f.dataDir, workspace: f.workspace, hooks: f.hooks, now: f.time }); schedulers.push(restored); await restored.start();
    expect(restored.list()).toHaveLength(1);
    expect(await restored.delete("提醒")).toBe(true); expect(restored.list()).toEqual([]);
  });
  it("delivers missed once tasks exactly once and falls back to WeChat", async () => {
    const f = await fixture();
    await f.scheduler.create({ name: "一次", prompt: "提醒", target: "deleted", schedule: { once: new Date(f.time() - 1000).toISOString() } });
    vi.mocked(f.hooks.targetExists).mockReturnValue(false);
    await f.scheduler.start(); await f.flush();
    expect(f.hooks.deliver).toHaveBeenCalledWith("wechat", "提醒", "missed", expect.any(AbortSignal));
    expect(f.scheduler.list()[0]?.enabled).toBe(false);
    await f.scheduler.tick(); await f.flush(); expect(f.hooks.deliver).toHaveBeenCalledTimes(1);
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
    await writeFile(join(f.workspace, "HEARTBEAT.md"), " \n"); f.advance(30 * 60_000); await f.scheduler.tick(); await f.flush(); expect(f.hooks.runTemporary).not.toHaveBeenCalled();
    await writeFile(join(f.workspace, "HEARTBEAT.md"), "检查今天日程"); f.advance(30 * 60_000); await f.scheduler.tick(); await vi.waitFor(() => expect(f.hooks.runTemporary).toHaveBeenCalledTimes(1)); await f.flush(); expect(f.hooks.deliverHeartbeat).not.toHaveBeenCalled();
    vi.mocked(f.hooks.runTemporary).mockResolvedValue("今天有预约"); f.advance(30 * 60_000); await f.scheduler.tick(); await vi.waitFor(() => expect(f.hooks.deliverHeartbeat).toHaveBeenCalledWith("今天有预约", expect.any(AbortSignal)));
    f.advance(10 * 3_600_000); await f.scheduler.tick(); await f.flush(); expect(f.hooks.runTemporary).toHaveBeenCalledTimes(2);
  });
  it("runs daily consolidation with seven dated notes and checks outreach", async () => {
    const f = await fixture(); await f.scheduler.start(); f.advance(15 * 3_600_000); await f.scheduler.tick(); await f.flush();
    expect(f.hooks.runTemporary).toHaveBeenCalledWith(expect.stringContaining("memory/2026-10-04.md"), "consolidation", expect.any(AbortSignal));
    expect(vi.mocked(f.hooks.runTemporary).mock.calls[0]?.[0].match(/memory\/\d{4}-\d{2}-\d{2}\.md/g)).toHaveLength(7);
    expect(f.hooks.checkOutreach).toHaveBeenCalled();
  });
  it("logs asynchronous failures and aborts pending work on close", async () => {
    const f = await fixture(); await f.scheduler.start();
    vi.mocked(f.hooks.deliver).mockRejectedValueOnce(new Error("模型失败"));
    await f.scheduler.create({ name: "失败", prompt: "测试", target: "wechat", schedule: { every: "1s" } }); f.advance(1000); await f.scheduler.tick(); await f.flush(); expect(f.hooks.log).toHaveBeenCalled();
    vi.mocked(f.hooks.deliver).mockImplementation(async (_target, _prompt, _kind, signal) => { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); });
    f.advance(1000); await f.scheduler.tick(); await f.flush(); await f.scheduler.close(); f.advance(1000); await f.scheduler.tick(); expect(f.hooks.deliver).toHaveBeenCalledTimes(2);
  });
});
