import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextCompactor, estimateTokens, type CompactionRecord } from "../src/context/compaction.js";
import { Session } from "../src/core/session.js";
import { appendJsonl, readJsonl } from "../src/store/jsonl.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });
const user = (content: string, timestamp = 1) => ({ role: "user" as const, content, timestamp });

describe("context compaction", () => {
  it("rescues memory silently, summarizes older turns, preserves full UI history and restores the summary", async () => {
    const path = join(dir, "session.jsonl");
    const history = [user("主人喜欢香港".repeat(400)), fauxAssistantMessage("记住了"), user("最近原文"), fauxAssistantMessage("最近回复")];
    for (const message of history) await appendJsonl(path, message);
    const faux = createFaux();
    const rescueFaux = createFaux();
    rescueFaux.setResponses([
      fauxAssistantMessage(fauxToolCall("append_memory", { content: "主人喜欢香港" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("silent rescue complete"),
      ...Array.from({ length: 30 }, () => fauxAssistantMessage("无需更多记忆")),
    ]);
    faux.setResponses([
      (ctx) => {
        expect(JSON.stringify(ctx.messages)).toContain("主人喜欢香港摘要");
        expect(JSON.stringify(ctx.messages)).toContain("最近原文");
        expect(JSON.stringify(ctx.messages)).not.toContain("主人喜欢香港".repeat(400));
        return fauxAssistantMessage("可见回复");
      },
      (ctx) => {
        expect(JSON.stringify(ctx.messages)).toContain("主人喜欢香港摘要");
        return fauxAssistantMessage("恢复回复");
      },
    ]);
    const model = { ...faux.getModel(), contextWindow: 2000 };
    const complete = vi.fn(async () => fauxAssistantMessage("主人喜欢香港摘要"));
    const events: unknown[] = [];
    const opts = {
      key: "wechat", transcriptPath: path, model, tools: [], streamFn: ((m, ctx, opts) => getCurrentSystemPrompt(ctx.messages).includes("静默抢救") ? fauxStreamFn(rescueFaux)(m, ctx, opts) : fauxStreamFn(faux)(m, ctx, opts)) satisfies import("@earendil-works/pi-agent-core").StreamFn, getApiKey: () => undefined,
      buildSystemPrompt: async () => "SYSTEM", emit: (e: unknown) => { events.push(e); },
      compaction: { backgroundModel: model, complete, workspace: dir, keepTurns: 2, now: () => new Date(2026, 9, 3) },
    };
    const session = await Session.open(opts);
    session.send("现在请求");
    await session.whenIdle();
    expect(await readFile(join(dir, "memory", "2026-10-03.md"), "utf8")).toContain("主人喜欢香港");
    expect(JSON.stringify(events)).not.toContain("silent rescue");
    expect(JSON.stringify(events)).not.toContain("append_memory");
    expect(session.history().items.map((i) => i.kind)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const records = await readJsonl<{ kind?: string }>(path);
    expect(records.filter((r) => r.kind === "compaction")).toHaveLength(1);
    const restored = await Session.open(opts);
    const summaryCalls = complete.mock.calls.length;
    expect(restored.history().items).toEqual(session.history().items);
    restored.send("继续");
    await restored.whenIdle();
    expect(complete).toHaveBeenCalledTimes(summaryCalls);
  });

  it("does not summarize or rescue below threshold", async () => {
    const faux = createFaux();
    const complete = vi.fn();
    const compactor = new ContextCompactor({ model: faux.getModel(), backgroundModel: faux.getModel(), workspace: dir, streamFn: fauxStreamFn(faux), getApiKey: () => undefined, complete, save: vi.fn() });
    const messages = [user("短消息")];
    expect(await compactor.transform(messages)).toEqual(messages);
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps original context and no summary record when background summary fails", async () => {
    const faux = createFaux();
    faux.setResponses([fauxAssistantMessage("no memory")]);
    const save = vi.fn();
    const onError = vi.fn();
    const messages = [user("x".repeat(1000)), fauxAssistantMessage("a"), user("new")];
    const compactor = new ContextCompactor({ model: { ...faux.getModel(), contextWindow: 2000 }, threshold: 0.1, backgroundModel: faux.getModel(), workspace: dir, streamFn: fauxStreamFn(faux), getApiKey: () => undefined, complete: async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "failed" }), save, keepTurns: 1, onError });
    expect(await compactor.transform(messages)).toEqual(messages);
    expect(save).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("aborts a silent rescue promptly without publishing or persisting its output", async () => {
    const path = join(dir, "aborted.jsonl");
    await appendJsonl(path, user("事实".repeat(500)));
    await appendJsonl(path, fauxAssistantMessage("旧回复"));
    const faux = createFaux(10);
    faux.setResponses([fauxAssistantMessage("silent ".repeat(100)), fauxAssistantMessage("never")]);
    const complete = vi.fn();
    const events: unknown[] = [];
    const session = await Session.open({ key: "wechat", transcriptPath: path, model: { ...faux.getModel(), contextWindow: 2000 }, tools: [], streamFn: fauxStreamFn(faux), getApiKey: () => undefined, buildSystemPrompt: async () => "SYSTEM", emit: (e) => { events.push(e); }, compaction: { backgroundModel: faux.getModel(), complete, workspace: dir, keepTurns: 1, threshold: 0.1 } });
    session.send("新请求");
    await new Promise((r) => setTimeout(r, 100));
    session.stop();
    await session.whenIdle();
    expect(complete).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("silent");
    expect(JSON.stringify(await readJsonl(path))).not.toContain("compaction");
  });

  it("preserves tool-call/result pairing in retained turns and restores latest summary", async () => {
    const faux = createFaux();
    const record: CompactionRecord = { kind: "compaction", through: 2, summary: "older", timestamp: 1 };
    const tool = fauxAssistantMessage(fauxToolCall("read", { path: "USER.md" }, { id: "r" }), { stopReason: "toolUse" });
    const messages = [user("old"), fauxAssistantMessage("old reply"), user("new"), tool, { role: "toolResult" as const, toolCallId: "r", toolName: "read", content: [{ type: "text" as const, text: "result" }], isError: false, timestamp: 2 }];
    const compactor = new ContextCompactor({ model: faux.getModel(), backgroundModel: faux.getModel(), workspace: dir, streamFn: fauxStreamFn(faux), getApiKey: () => undefined, complete: vi.fn(), save: vi.fn() }, record);
    const projected = await compactor.transform(messages);
    expect(projected.slice(1)).toEqual(messages.slice(2));
    expect(estimateTokens(projected)).toBeGreaterThan(0);
  });

  it("chunks oversized tool results and smaller background windows without losing first or last facts", async () => {
    const faux = createFaux();
    faux.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage("无需记忆")));
    const model = { ...faux.getModel(), contextWindow: 1800 };
    const backgroundModel = { ...faux.getModel(), contextWindow: 500 };
    const payload = `首部关键事实${"数据".repeat(1800)}尾部关键事实`;
    const messages = [user("旧要求"), fauxAssistantMessage("旧回复"), user("读取数据"), fauxAssistantMessage(fauxToolCall("read", { path: "large.txt" }, { id: "big" }), { stopReason: "toolUse" }), { role: "toolResult" as const, toolCallId: "big", toolName: "read", content: [{ type: "text" as const, text: payload }], isError: false, timestamp: 2 }];
    const inputs: string[] = [];
    let saved: CompactionRecord | undefined;
    const opts = {
      model, backgroundModel, workspace: dir, getApiKey: () => undefined, keepTurns: 1,
      streamFn: ((m, ctx, options) => {
        expect(estimateTokens(ctx.messages) + (options?.maxTokens ?? 0)).toBeLessThan(m.contextWindow);
        return fauxStreamFn(faux)(m, ctx, options);
      }) satisfies import("@earendil-works/pi-agent-core").StreamFn,
      complete: (async (m, ctx, options) => {
        expect(estimateTokens([{ role: "system", content: ctx.systemPrompt ?? "", timestamp: 0 }, ...ctx.messages]) + (options?.maxTokens ?? 0)).toBeLessThan(m.contextWindow);
        inputs.push(JSON.stringify(ctx.messages));
        return fauxAssistantMessage("关键事实摘要");
      }) satisfies import("../src/providers/models.js").CompleteFn,
      save: async (record: CompactionRecord) => { saved = record; },
    };
    const projected = await new ContextCompactor(opts).transform(messages);
    expect(inputs.join("")).toContain("首部关键事实");
    expect(inputs.join("")).toContain("尾部关键事实");
    expect(estimateTokens(projected)).toBeLessThan(model.contextWindow * 0.85);
    expect(projected.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "big", content: [{ type: "text", text: "工具结果摘要：关键事实摘要" }] });
    expect(messages.at(-1)?.content).toEqual([{ type: "text", text: payload }]);
    expect(saved?.replacements).toHaveLength(1);
    expect(await new ContextCompactor(opts, saved).transform(messages)).toEqual(projected);
  });

  it("does not persist a partial multi-chunk summary after cancellation", async () => {
    const faux = createFaux();
    faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage("无需记忆")));
    const controller = new AbortController();
    const save = vi.fn();
    let calls = 0;
    const messages = [user("重要事实".repeat(500)), fauxAssistantMessage("回复"), user("最新请求")];
    const compactor = new ContextCompactor({ model: { ...faux.getModel(), contextWindow: 2000 }, backgroundModel: { ...faux.getModel(), contextWindow: 500 }, workspace: dir, streamFn: fauxStreamFn(faux), getApiKey: () => undefined, keepTurns: 1, save, complete: async () => { if (++calls === 2) controller.abort(); return fauxAssistantMessage("片段摘要"); } });
    expect(await compactor.transform(messages, controller.signal)).toEqual(messages);
    expect(calls).toBe(2);
    expect(save).not.toHaveBeenCalled();
  });
});
