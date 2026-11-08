import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TriggerLog, type TriggerRequest, type TriggerSource } from "../src/triggers/index.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

const DAY = 86_400_000;

let dir: string;
let path: string;
let logs: TriggerLog[];
beforeEach(async () => {
  dir = await makeTmpDir();
  path = join(dir, "triggers.jsonl");
  logs = [];
});
afterEach(async () => {
  await Promise.all(logs.splice(0).map((log) => log.close()));
  await removeTmpDir(dir);
});

async function open(options: { sources?: readonly TriggerSource[]; recordOnly?: string[]; allow?: string[]; now?: () => number; onChange?: () => void; onRecord?: (record: TriggerRequest) => void } = {}): Promise<TriggerLog> {
  const log = new TriggerLog({ path, ...options });
  logs.push(log);
  await log.open();
  return log;
}

const heartbeat = (text = "Read HEARTBEAT.md"): TriggerRequest => ({ source: "heartbeat", title: "Heartbeat check", text });

describe("trigger log", () => {
  it("lets every source run unless it is set to record only", async () => {
    const onChange = vi.fn();
    const log = await open({ recordOnly: ["proactive chat"], onChange });
    expect(log.admit(heartbeat())).toBe(true);
    expect(log.list()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("records the work of a source set to record only, newest first", async () => {
    let now = 1000;
    const onRecord = vi.fn();
    const log = await open({ recordOnly: ["heartbeat", "proactive chat"], now: () => now, onRecord });
    expect(log.admit(heartbeat())).toBe(false);
    now = 2000;
    expect(log.admit({ source: "proactive chat", title: "Proactive chat", text: "say hi" })).toBe(false);
    expect(log.admit({ source: "watchdog", title: "Watchdog check", text: "look" })).toBe(true);
    expect(log.list().map((record) => [record.source, record.at])).toEqual([["proactive chat", 2000], ["heartbeat", 1000]]);
    expect(onRecord).toHaveBeenCalledTimes(2);
    expect(onRecord.mock.calls[0]![0]).toMatchObject({ source: "heartbeat", title: "Heartbeat check", text: "Read HEARTBEAT.md" });
  });

  it("reads its records back after a restart and drops those past the retention", async () => {
    let now = 10 * DAY;
    const log = await open({ recordOnly: ["heartbeat"], now: () => now });
    log.admit(heartbeat());
    log.admit({ source: "heartbeat", title: "Heartbeat check", text: "second" });
    await log.close();

    now = 12 * DAY;
    const restarted = await open({ recordOnly: ["heartbeat"], now: () => now });
    expect(restarted.list().map((record) => record.text)).toEqual(["second", "Read HEARTBEAT.md"]);

    now = 20 * DAY;
    const later = await open({ recordOnly: ["heartbeat"], now: () => now });
    expect(later.list()).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("");
  });

  it("records an untried source until the owner allows it, then lets it act", async () => {
    const sources: TriggerSource[] = [{ name: "inbox", defaultMode: "record" }, { name: "heartbeat", defaultMode: "act" }];
    const recorded = await open({ sources, now: () => 1000 });
    expect(recorded.modeOf("inbox")).toBe("record");
    expect(recorded.admit({ source: "inbox", title: "New mail", text: "three unread" })).toBe(false);
    expect(recorded.list()).toHaveLength(1);

    const allowed = await open({ sources, allow: ["inbox"], now: () => 1000 });
    expect(allowed.modeOf("inbox")).toBe("act");
    expect(allowed.admit({ source: "inbox", title: "New mail", text: "three unread" })).toBe(true);
    expect(allowed.list()).toEqual([]);

    const overruled = await open({ sources, allow: ["inbox"], recordOnly: ["inbox"], now: () => 1000 });
    expect(overruled.modeOf("inbox")).toBe("record");
  });

  it("refuses a source it does not know", async () => {
    const log = await open({ recordOnly: ["heartbeat"] });
    expect(() => log.admit({ source: "proactive chats", title: "t", text: "x" })).toThrow('Unknown trigger source "proactive chats"');
    await expect(open({ recordOnly: ["proactive chats"] })).rejects.toThrow('Unknown trigger source "proactive chats"');
  });

  it("survives a torn last line", async () => {    await writeFile(path, `${JSON.stringify({ id: "a", at: 1000, source: "heartbeat", title: "t", text: "kept" })}\n{"id":"b","at":`, "utf8");
    const log = await open({ now: () => 2000 });
    expect(log.list().map((record) => record.text)).toEqual(["kept"]);
  });

  it("bounds the text it stores", async () => {
    const log = await open({ recordOnly: ["wiki"], now: () => 1000 });
    log.admit({ source: "wiki", title: "Scheduled wiki run", text: "x".repeat(5000) });
    const [record] = log.list();
    expect(record!.text).toBe(`${"x".repeat(4000)}…[+1000 chars]`);
  });
});
