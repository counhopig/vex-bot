import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../store/atomic.js";

const HOUR = 3_600_000;
const clamp = (value: number) => Math.max(0, Math.min(100, value));
export interface Feeling { mood: number; energy: number; reason: string; at: number; hours: number }
export interface PersonaState {
  energy: number; mood: number; social: number; updatedAt: number;
  feelings: Feeling[]; lastWechatMessage: number; outreachDay: string;
  outreachCount: number; pendingOutreach: number[];
}
export interface PersonaOptions {
  path: string; now?: () => number; warn?: (message: string) => void;
  sleep?: readonly [string, string];
  outreach?: { enabled?: boolean; socialThreshold?: number; quietHours?: number; dailyLimit?: number };
}
function clockMinutes(value: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("Invalid sleep time");
  const [h, m] = value.split(":").map(Number);
  return h! * 60 + m!;
}
function day(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
export function isResting(at: number, sleep: readonly [string, string] = ["23:00", "07:00"]): boolean {
  const [start, end] = sleep.map(clockMinutes) as [number, number];
  const d = new Date(at), minutes = d.getHours() * 60 + d.getMinutes();
  return start > end ? minutes >= start || minutes < end : minutes >= start && minutes < end;
}
function valid(value: unknown): value is PersonaState {
  if (!value || typeof value !== "object") return false;
  const s = value as PersonaState;
  return [s.energy, s.mood, s.social].every(n => Number.isFinite(n) && n >= 0 && n <= 100)
    && [s.updatedAt, s.lastWechatMessage, s.outreachCount].every(n => Number.isFinite(n) && n >= 0)
    && Number.isInteger(s.outreachCount) && typeof s.outreachDay === "string"
    && Array.isArray(s.pendingOutreach) && s.pendingOutreach.every(n => Number.isFinite(n) && n >= 0)
    && Array.isArray(s.feelings) && s.feelings.length <= 5 && s.feelings.every(f => f && typeof f.reason === "string"
      && [f.mood, f.energy].every(n => Number.isFinite(n) && Math.abs(n) <= 30)
      && Number.isFinite(f.at) && f.at >= 0 && Number.isFinite(f.hours) && f.hours > 0 && f.hours <= 24);
}
export class Persona {
  private readonly now: () => number;
  private readonly sleep: readonly [number, number];
  private saving: Promise<void> = Promise.resolve();
  private constructor(private readonly options: PersonaOptions, private state: PersonaState) {
    this.now = options.now ?? Date.now;
    this.sleep = (options.sleep ?? ["23:00", "07:00"]).map(clockMinutes) as [number, number];
  }
  static async open(options: PersonaOptions): Promise<Persona> {
    const now = (options.now ?? Date.now)();
    let state: PersonaState = { energy: 80, mood: 70, social: 50, updatedAt: now, feelings: [],
      lastWechatMessage: now, outreachDay: day(now), outreachCount: 0, pendingOutreach: [] };
    let rebuild = false;
    try {
      const parsed: unknown = JSON.parse(await readFile(options.path, "utf8"));
      if (!valid(parsed)) throw new Error("Invalid mood state");
      state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.warn?.("mood.json 损坏，以初始值重建");
      rebuild = true;
    }
    const persona = new Persona(options, state);
    if (rebuild) await persona.save();
    return persona;
  }
  isResting(at = this.now()): boolean {
    const d = new Date(at), minutes = d.getHours() * 60 + d.getMinutes();
    const [start, end] = this.sleep;
    return start > end ? minutes >= start || minutes < end : minutes >= start && minutes < end;
  }
  private update(): void {
    const now = this.now();
    if (now > this.state.updatedAt) {
      let cursor = this.state.updatedAt;
      while (cursor < now) {
        const boundary = new Date(cursor);
        boundary.setHours(24, 0, 0, 0);
        let next = Math.min(now, boundary.getTime());
        for (const minutes of this.sleep) {
          const candidate = new Date(cursor);
          candidate.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
          if (candidate.getTime() > cursor) next = Math.min(next, candidate.getTime());
        }
        this.state.energy = clamp(this.state.energy + (next - cursor) / HOUR * (this.isResting(cursor) ? 10 : -2));
        cursor = next;
      }
      const hours = (now - this.state.updatedAt) / HOUR;
      this.state.mood = clamp(this.state.mood - hours * 1.6);
      this.state.social = clamp(this.state.social + hours * 5);
      this.state.updatedAt = now;
    }
    const expired = this.state.pendingOutreach.filter(at => now >= at + 2 * HOUR);
    this.state.mood = clamp(this.state.mood - expired.length * 10);
    this.state.pendingOutreach = this.state.pendingOutreach.filter(at => now < at + 2 * HOUR);
    this.state.feelings = this.state.feelings.filter(f => now < f.at + f.hours * HOUR);
    if (this.state.outreachDay !== day(now)) {
      this.state.outreachDay = day(now); this.state.outreachCount = 0;
    }
  }
  snapshot(): PersonaState {
    this.update();
    const copy = structuredClone(this.state), now = this.now();
    for (const f of copy.feelings) {
      const fraction = Math.min(1, Math.max(0, 1 - (now - f.at) / (f.hours * HOUR)));
      copy.mood += f.mood * fraction; copy.energy += f.energy * fraction;
    }
    copy.mood = clamp(copy.mood); copy.energy = clamp(copy.energy);
    return copy;
  }
  userMessage(source: "wechat" | "web"): void {
    this.update();
    if (source === "wechat") { this.state.lastWechatMessage = this.now(); this.state.pendingOutreach = []; }
  }
  interactionCompleted(): void {
    this.update();
    this.state.energy = clamp(this.state.energy + 3);
    this.state.mood = clamp(this.state.mood + 3.6);
    this.state.social = clamp(this.state.social - 15);
  }
  feel(input: { mood: number; energy?: number; reason: string; hours?: number }): void {
    const energy = input.energy ?? 0, hours = input.hours ?? 2;
    if (![input.mood, energy].every(n => Number.isFinite(n) && Math.abs(n) <= 30)
      || !Number.isFinite(hours) || hours <= 0 || hours > 24 || !input.reason.trim()) throw new Error("Invalid feeling");
    this.update();
    this.state.feelings.push({ ...input, energy, hours, at: this.now() });
    this.state.feelings = this.state.feelings.slice(-5);
  }
  shouldOutreach(wechatIdle: boolean): boolean {
    const s = this.snapshot(), config = this.options.outreach;
    return (config?.enabled ?? true) && wechatIdle && !this.isResting()
      && s.social > (config?.socialThreshold ?? 70)
      && this.now() - s.lastWechatMessage > (config?.quietHours ?? 3) * HOUR
      && s.outreachCount < (config?.dailyLimit ?? 3);
  }
  outreachSent(replied = false): void {
    this.update(); this.state.outreachCount++; if (!replied) this.state.pendingOutreach.push(this.now());
  }
  describe(): string {
    const s = this.snapshot(), parts: string[] = [];
    if (s.energy < 20) parts.push("累到不想动"); else if (s.energy < 50) parts.push("有点疲惫"); else if (s.energy > 80) parts.push("精力充沛");
    if (s.mood < 20) parts.push("心情低落"); else if (s.mood < 50) parts.push("兴致不高"); else if (s.mood > 80) parts.push("心情很好");
    if (s.social > 80) parts.push("很想找人说话"); else if (s.social >= 50) parts.push("有点想聊天");
    for (const f of s.feelings) {
      const fraction = Math.min(1, Math.max(0, 1 - (this.now() - f.at) / (f.hours * HOUR)));
      if (fraction >= 0.1 && (f.mood !== 0 || f.energy !== 0)) parts.push(`${fraction > 0.66 ? "强烈的" : fraction > 0.33 ? "有些" : "淡淡的"}${f.reason}`);
    }
    if (this.isResting()) parts.push("现在是你的休息时间，语气更困倦，回复更简短");
    return `${parts.length ? parts.join("；") + "。" : ""}情绪只影响语气与话量，不影响完成主人请求的质量。`;
  }
  save(): Promise<void> {
    this.update();
    const data = JSON.stringify(this.state, null, 2) + "\n";
    this.saving = this.saving.catch(() => {}).then(() => writeFileAtomic(this.options.path, data, 0o600, 0o700));
    return this.saving;
  }
}
