import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "../src/policy/approvals.js";
import { createToolGate } from "../src/policy/gate.js";
import { ToolPolicy } from "../src/policy/policy.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const input = { sessionKey: "web:1", windowLabel: "网页会话「测试」", toolName: "bash", args: { command: "ls" } };

describe("ApprovalManager", () => {
  it("lists a pending request and resolves it with the first answer", async () => {
    const onChange = vi.fn();
    const approvals = new ApprovalManager({ onChange, now: () => 1000 });
    const outcome = approvals.request(input);
    const [request] = approvals.pending();
    expect(request).toMatchObject({ sessionKey: "web:1", windowLabel: "网页会话「测试」", toolName: "bash", summary: "ls", createdAt: 1000, expiresAt: 601000 });
    expect(approvals.answer(request!.id, "allow")).toBe(true);
    expect(approvals.answer(request!.id, "deny")).toBe(false);
    await expect(outcome).resolves.toEqual({ allowed: true });
    expect(approvals.pending()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("explains a denial", async () => {
    const approvals = new ApprovalManager();
    const outcome = approvals.request(input);
    approvals.answer(approvals.pending()[0]!.id, "deny");
    await expect(outcome).resolves.toEqual({ allowed: false, reason: "主人拒绝了这次 bash 调用。" });
  });

  it("remembers allow_session for that session and tool only", async () => {
    const approvals = new ApprovalManager();
    const outcome = approvals.request(input);
    approvals.answer(approvals.pending()[0]!.id, "allow_session");
    await expect(outcome).resolves.toEqual({ allowed: true });
    expect(approvals.isSessionAllowed("web:1", "bash")).toBe(true);
    expect(approvals.isSessionAllowed("web:1", "write")).toBe(false);
    expect(approvals.isSessionAllowed("wechat", "bash")).toBe(false);
  });

  it("denies after ten minutes without an answer", async () => {
    const approvals = new ApprovalManager();
    const outcome = approvals.request(input);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(outcome).resolves.toEqual({ allowed: false, reason: "主人 10 分钟内没有答复，这次 bash 调用已取消。" });
    expect(approvals.pending()).toEqual([]);
  });

  it("denies when the turn is aborted", async () => {
    const approvals = new ApprovalManager();
    const controller = new AbortController();
    const outcome = approvals.request({ ...input, signal: controller.signal });
    controller.abort();
    await expect(outcome).resolves.toEqual({ allowed: false, reason: "本轮已被中断。" });
    const already = approvals.request({ ...input, signal: controller.signal });
    await expect(already).resolves.toEqual({ allowed: false, reason: "本轮已被中断。" });
  });

  it("denies everything on dispose", async () => {
    const approvals = new ApprovalManager();
    const a = approvals.request(input);
    const b = approvals.request({ ...input, toolName: "write" });
    approvals.dispose();
    await expect(a).resolves.toEqual({ allowed: false, reason: "vexd 正在关闭。" });
    await expect(b).resolves.toEqual({ allowed: false, reason: "vexd 正在关闭。" });
  });
});

function ctx(name: string, args: unknown): BeforeToolCallContext {
  return {
    assistantMessage: {} as BeforeToolCallContext["assistantMessage"],
    toolCall: { type: "toolCall", id: "c1", name, arguments: {} },
    args,
    context: { messages: [] },
  };
}

describe("createToolGate", () => {
  const policy = new ToolPolicy({ workspace: "/ws", overrides: { find: "deny" } });

  it("lets allowed tools through without asking", async () => {
    const approvals = new ApprovalManager();
    const gate = createToolGate({ policy, approvals, sessionKey: "web:1", windowLabel: () => "网页" });
    await expect(gate(ctx("read", { path: "/etc/hosts" }))).resolves.toBeUndefined();
    expect(approvals.pending()).toEqual([]);
  });

  it("blocks denied tools", async () => {
    const gate = createToolGate({ policy, approvals: new ApprovalManager(), sessionKey: "web:1", windowLabel: () => "网页" });
    await expect(gate(ctx("find", {}))).resolves.toEqual({ block: true, reason: "工具 find 已被禁用。" });
  });

  it("asks for approval and maps the outcome", async () => {
    const approvals = new ApprovalManager();
    const gate = createToolGate({ policy, approvals, sessionKey: "web:1", windowLabel: () => "网页会话「A」" });
    const allowed = gate(ctx("bash", { command: "ls" }));
    expect(approvals.pending()[0]?.windowLabel).toBe("网页会话「A」");
    approvals.answer(approvals.pending()[0]!.id, "allow_session");
    await expect(allowed).resolves.toBeUndefined();
    await expect(gate(ctx("bash", { command: "pwd" }))).resolves.toBeUndefined();
    expect(approvals.pending()).toEqual([]);

    const denied = gate(ctx("write", { path: "/etc/x" }));
    approvals.answer(approvals.pending()[0]!.id, "deny");
    await expect(denied).resolves.toEqual({ block: true, reason: "主人拒绝了这次 write 调用。" });
  });
});
