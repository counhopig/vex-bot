import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import { writeFileAtomic } from "../store/atomic.js";

export type ScheduleRule = { cron: string } | { every: string } | { once: string };
export interface ScheduledTask { id: string; name: string; schedule: ScheduleRule; prompt: string; target: string; enabled: boolean; nextAt: number | null }
export interface SchedulerHooks {
  /** Resolves after the delivered turn has completed, including any steering. */
  deliver(target: string, prompt: string, kind: "scheduled" | "missed", signal: AbortSignal): Promise<void>;
  targetExists(target: string): boolean | Promise<boolean>;
  runTemporary(prompt: string, kind: "heartbeat" | "consolidation", signal: AbortSignal): Promise<string>;
  /** Sends to WeChat and appends an assistant message to its permanent history. */
  deliverHeartbeat(text: string, signal: AbortSignal): Promise<void>;
  checkOutreach(signal: AbortSignal): Promise<void>;
  log(error: unknown): void;
}
export interface SchedulerOptions {
  dataDir: string; workspace: string; hooks: SchedulerHooks; now?: () => number;
  heartbeat?: { every: string; activeHours: [string, string] };
  memory?: { consolidateAt: string };
  outreach?: { enabled: boolean; checkEvery: string };
}
export function duration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value);
  if (!match) throw new Error("间隔必须是正数加 s、m、h 或 d");
  const result = Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!] ?? 0);
  if (!Number.isFinite(result) || result < 1000) throw new Error("间隔至少为一秒");
  return result;
}
function minute(value: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("时间必须是 HH:mm");
  const [h, m] = value.split(":").map(Number); return h! * 60 + m!;
}
export function activeAt(now: number, hours: [string, string]): boolean {
  const date = new Date(now), current = date.getHours() * 60 + date.getMinutes();
  const start = minute(hours[0]), end = minute(hours[1]);
  return start === end || (start < end ? current >= start && current < end : current >= start || current < end);
}
function stamp(at: number): string {
  const d = new Date(at), pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function next(rule: ScheduleRule, now: number): number | null {
  if (!rule || typeof rule !== "object" || Object.keys(rule).length !== 1 || !("every" in rule || "once" in rule || "cron" in rule)) throw new Error("时间规则无效");
  if ("every" in rule) return now + duration(rule.every);
  if ("once" in rule) { const time = Date.parse(rule.once); if (!Number.isFinite(time)) throw new Error("一次性时间无效"); return time; }
  if (typeof rule.cron !== "string" || !rule.cron.trim()) throw new Error("cron 规则不能为空");
  const cron = new Cron(rule.cron, { paused: true });
  try { return cron.nextRun(new Date(now))?.getTime() ?? null; } finally { cron.stop(); }
}

export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private readonly now: () => number;
  private readonly abort = new AbortController();
  private readonly running = new Map<string, Promise<void>>();
  private mutations: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private ticking = false;
  private heartbeatAt: number;
  private outreachAt: number;
  private consolidationAt: number | null;
  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.heartbeatAt = this.now() + duration(options.heartbeat?.every ?? "30m");
    this.outreachAt = this.now() + duration(options.outreach?.checkEvery ?? "30m");
    const time = options.memory?.consolidateAt ?? "03:00"; minute(time);
    const [h, m] = time.split(":");
    this.consolidationAt = next({ cron: `${m} ${h} * * *` }, this.now());
    activeAt(this.now(), options.heartbeat?.activeHours ?? ["08:00", "22:00"]);
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.mutations.then(action); this.mutations = pending.catch(() => {}); return pending;
  }
  private save(): Promise<void> { return writeFileAtomic(join(this.options.dataDir, "schedules.json"), JSON.stringify(this.tasks, null, 2), 0o600); }
  async start(): Promise<void> {
    if (this.stopped) throw new Error("调度器已关闭");
    if (this.timer) return;
    const file = join(this.options.dataDir, "schedules.json");
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("定时任务文件无效");
      const names = new Set<string>();
      for (const item of parsed) {
        if (!item || typeof item.id !== "string" || typeof item.name !== "string" || !item.name.trim() || names.has(item.name) || typeof item.prompt !== "string" || typeof item.target !== "string" || typeof item.enabled !== "boolean" || !item.schedule || Object.keys(item.schedule).length !== 1) throw new Error("定时任务文件无效");
        next(item.schedule, this.now()); names.add(item.name);
        if (item.nextAt !== null && (!Number.isFinite(item.nextAt) || typeof item.nextAt !== "number")) throw new Error("定时任务触发时间无效");
      }
      this.tasks = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const backup = `${file}.bad-${this.now()}`;
        const moved = await rename(file, backup).then(() => true, () => false);
        this.options.hooks.log(new Error(`定时任务文件无法读取${moved ? `，已移至 ${backup}` : ""}：${error instanceof Error ? error.message : String(error)}`));
      }
    }
    const now = this.now();
    for (const task of this.tasks) {
      if (task.enabled && task.nextAt !== null && task.nextAt <= now && !("once" in task.schedule)) task.nextAt = next(task.schedule, now);
    }
    await this.tick(true);
    if (this.stopped) return;
    this.timer = setInterval(() => { void this.tick().catch(this.options.hooks.log); }, 1000); this.timer.unref();
  }
  list(): ScheduledTask[] { return structuredClone(this.tasks); }
  create(input: { name: string; schedule: ScheduleRule; prompt: string; target: string; enabled?: boolean }): Promise<ScheduledTask> {
    return this.mutate(async () => {
      if (this.stopped) throw new Error("调度器已关闭");
      if (!input.name.trim() || !input.prompt.trim() || !input.target.trim()) throw new Error("名称、消息和目标不能为空");
      if (this.tasks.some(task => task.name === input.name)) throw new Error("定时任务名称已存在");
      if (Object.keys(input.schedule).length !== 1) throw new Error("只能指定一个时间规则");
      if ("once" in input.schedule && Date.parse(input.schedule.once) <= this.now()) throw new Error("一次性时间已过");
      const task: ScheduledTask = { ...structuredClone(input), id: randomUUID(), enabled: input.enabled ?? true, nextAt: next(input.schedule, this.now()) };
      this.tasks.push(task); try { await this.save(); } catch (error) { this.tasks.pop(); throw error; } return structuredClone(task);
    });
  }
  delete(idOrName: string): Promise<boolean> {
    return this.mutate(async () => { const old = this.tasks; this.tasks = old.filter(t => t.id !== idOrName && t.name !== idOrName); if (old.length === this.tasks.length) return false; try { await this.save(); } catch (error) { this.tasks = old; throw error; } return true; });
  }
  private launch(key: string, action: () => Promise<void>): void {
    if (this.stopped || this.running.has(key)) return;
    const promise = Promise.resolve().then(() => this.stopped ? undefined : action()).catch(this.options.hooks.log).finally(() => { this.running.delete(key); });
    this.running.set(key, promise);
  }
  async tick(startup = false): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      await this.mutate(async () => {
        for (const task of this.tasks) {
          if (!task.enabled || task.nextAt === null || task.nextAt > now) continue;
          const busy = this.running.has(task.id);
          const once = "once" in task.schedule;
          const dueAt = task.nextAt;
          const previous = { enabled: task.enabled, nextAt: task.nextAt };
          if (once) task.enabled = false;
          else task.nextAt = next(task.schedule, now);
          try { await this.save(); } catch (error) { Object.assign(task, previous); throw error; }
          if (busy) continue;
          this.launch(task.id, async () => {
            const target = task.target === "wechat" || await this.options.hooks.targetExists(task.target) ? task.target : "wechat";
            const missed = startup && once;
            const label = missed ? `【错过的定时任务「${task.name}」，原定 ${stamp(dueAt)}】` : `【定时任务「${task.name}」】`;
            if (!this.stopped) await this.options.hooks.deliver(target, `${label}${task.prompt}`, missed ? "missed" : "scheduled", this.abort.signal);
          });
        }
      });
      if (now >= this.heartbeatAt) {
        this.heartbeatAt = now + duration(this.options.heartbeat?.every ?? "30m");
        if (activeAt(now, this.options.heartbeat?.activeHours ?? ["08:00", "22:00"])) this.launch("heartbeat", () => this.heartbeat());
      }
      if (this.consolidationAt !== null && now >= this.consolidationAt) {
        const [h, m] = (this.options.memory?.consolidateAt ?? "03:00").split(":");
        this.consolidationAt = next({ cron: `${m} ${h} * * *` }, now);
        this.launch("consolidation", () => this.consolidate(now));
      }
      if (now >= this.outreachAt) { this.outreachAt = now + duration(this.options.outreach?.checkEvery ?? "30m"); if (this.options.outreach?.enabled !== false) this.launch("outreach", () => this.options.hooks.checkOutreach(this.abort.signal)); }
    } finally { this.ticking = false; }
  }
  private async heartbeat(): Promise<void> {
    let text: string;
    try { text = await readFile(join(this.options.workspace, "HEARTBEAT.md"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!text.trim() || this.stopped) return;
    const result = await this.options.hooks.runTemporary("读取工作区 HEARTBEAT.md，逐项检查。无需告知主人时仅回复 HEARTBEAT_OK。", "heartbeat", this.abort.signal);
    if (!this.stopped && result.trim() && result.trim() !== "HEARTBEAT_OK") await this.options.hooks.deliverHeartbeat(result, this.abort.signal);
  }
  private async consolidate(now: number): Promise<void> {
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) { const date = new Date(now); date.setDate(date.getDate() - i); dates.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`); }
    await this.options.hooks.runTemporary(`读取最近七天每日笔记（${dates.map(date => `memory/${date}.md`).join("、")}；不存在的文件跳过），以及 MEMORY.md 与 USER.md。把反复出现或明确重要的内容提炼进 MEMORY.md / USER.md，合并重复条目、删除失效条目，保持 MEMORY.md 不超过 100 行。只编辑工作区内文件，不向主人发送消息。`, "consolidation", this.abort.signal);
  }
  async close(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.abort.abort(); await this.mutations; await Promise.allSettled([...this.running.values()]); }
}
