import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Persona } from "../src/persona/index.js";
import { createFeelTool } from "../src/tools/feel.js";

async function setup(at = new Date(2026, 9, 3, 22).getTime()) {
  let now = at;
  const path = join(await mkdtemp(join(tmpdir(), "vex-persona-")), "mood.json");
  const persona = await Persona.open({ path, now: () => now });
  return { persona, path, advance: (hours: number) => { now += hours * 3_600_000; } };
}
describe("persona", () => {
  it("integrates awake and cross-midnight sleep time, including downtime", async () => {
    const { persona, path, advance } = await setup();
    advance(10);
    expect(persona.snapshot().energy).toBe(98);
    expect(persona.snapshot().mood).toBeCloseTo(54);
    await persona.save();
    const restored = await Persona.open({ path, now: () => new Date(2026, 9, 4, 18).getTime() });
    expect(restored.snapshot().energy).toBe(78);
  });
  it("settles interactions, expires feelings and caps five feelings", async () => {
    const { persona, advance } = await setup(new Date(2026, 9, 3, 12).getTime());
    persona.interactionCompleted();
    expect(persona.snapshot()).toMatchObject({ energy: 83, mood: 73.6, social: 35 });
    persona.feel({ mood: 20, reason: "被夸奖" });
    advance(1);
    expect(persona.snapshot().mood).toBeCloseTo(82);
    expect(persona.describe()).toContain("被夸奖");
    advance(1);
    expect(persona.snapshot().feelings).toHaveLength(0);
    for (let i = 0; i < 6; i++) persona.feel({ mood: 1, reason: String(i) });
    expect(persona.snapshot().feelings.map(f => f.reason)).toEqual(["1", "2", "3", "4", "5"]);
  });
  it("tracks WeChat separately and penalizes unreplied outreach exactly once", async () => {
    const { persona, advance } = await setup(new Date(2026, 9, 3, 8).getTime());
    persona.userMessage("wechat");
    advance(5);
    persona.userMessage("web");
    expect(persona.shouldOutreach(true)).toBe(true);
    persona.outreachSent();
    const before = persona.snapshot().mood;
    advance(2);
    expect(persona.snapshot().mood).toBeCloseTo(before - 3.2 - 10);
    expect(persona.snapshot().mood).toBeCloseTo(before - 3.2 - 10);
    persona.outreachSent();
    advance(1);
    persona.userMessage("wechat");
    const replied = persona.snapshot().mood;
    advance(1);
    expect(persona.snapshot().mood).toBeCloseTo(replied - 1.6);
    expect(persona.shouldOutreach(false)).toBe(false);
  });
  it("recovers corrupt state and persists atomically", async () => {
    const { path } = await setup();
    await writeFile(path, '{"energy":null}');
    const warnings: string[] = [];
    const persona = await Persona.open({ path, now: () => new Date(2026, 9, 3, 12).getTime(), warn: message => warnings.push(message) });
    expect(persona.snapshot().energy).toBeCloseTo(80, 1);
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(await readFile(path, "utf8")).energy).toBe(80);
  });
  it("honors strict thresholds, quiet period, rest, disabled status and daily limit", async () => {
    const { persona, path, advance } = await setup(new Date(2026, 9, 3, 8).getTime());
    advance(4);
    expect(persona.snapshot().social).toBe(70);
    expect(persona.shouldOutreach(true)).toBe(false);
    advance(0.1);
    expect(persona.shouldOutreach(true)).toBe(true);
    for (let i = 0; i < 3; i++) persona.outreachSent();
    expect(persona.shouldOutreach(true)).toBe(false);
    advance(11);
    expect(persona.isResting()).toBe(true);
    expect(persona.shouldOutreach(true)).toBe(false);
    advance(9);
    expect(persona.shouldOutreach(true)).toBe(true);
    await persona.save();
    const disabled = await Persona.open({ path, outreach: { enabled: false } });
    expect(disabled.shouldOutreach(true)).toBe(false);
    persona.userMessage("wechat");
    advance(3);
    expect(persona.shouldOutreach(true)).toBe(false);
  });
  it("supports same-day rest, long downtime, validation and narrative boundaries", async () => {
    const { path } = await setup();
    let now = new Date(2026, 9, 3, 8).getTime();
    const persona = await Persona.open({ path, now: () => now, sleep: ["12:00", "14:00"] });
    expect(persona.isResting(new Date(2026, 9, 3, 12).getTime())).toBe(true);
    expect(persona.isResting(new Date(2026, 9, 3, 14).getTime())).toBe(false);
    expect(() => persona.feel({ mood: 31, reason: "x" })).toThrow();
    expect(() => persona.feel({ mood: 1, reason: "x", hours: 25 })).toThrow();
    now += 30 * 24 * 3_600_000;
    expect(persona.snapshot()).toMatchObject({ energy: 0, mood: 0, social: 100 });
    expect(persona.describe()).toContain("累到不想动；心情低落；很想找人说话");
  });
  it("persists feelings recorded through the tool", async () => {
    const { persona, path } = await setup();
    const tool = createFeelTool(persona);
    const result = await tool.execute("feel-1", { mood: 15, reason: "完成任务" });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(JSON.parse(await readFile(path, "utf8")).feelings).toHaveLength(1);
  });
  it("counts delivered outreach without a pending penalty when the owner already replied during generation", async () => {
    const { persona, advance } = await setup();
    persona.userMessage("wechat");
    persona.interactionCompleted();
    persona.outreachSent(true);
    expect(persona.snapshot().outreachCount).toBe(1);
    expect(persona.snapshot().pendingOutreach).toEqual([]);
    const mood = persona.snapshot().mood;
    advance(2);
    expect(persona.snapshot().mood).toBeCloseTo(mood - 3.2);
  });
});
