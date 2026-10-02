import { describe, expect, it } from "vitest";
import { ToolPolicy } from "../src/policy/policy.js";
import { summarizeArgs } from "../src/tools/summary.js";

describe("summarizeArgs", () => {
  it("picks the most telling argument", () => {
    expect(summarizeArgs("bash", { command: "ls -la", timeout: 5 })).toBe("ls -la");
    expect(summarizeArgs("write", { path: "a.md", content: "x" })).toBe("a.md");
    expect(summarizeArgs("grep", { pattern: "咖啡" })).toBe("咖啡");
    expect(summarizeArgs("other", { a: 1 })).toBe('{"a":1}');
  });

  it("truncates long summaries", () => {
    const summary = summarizeArgs("bash", { command: "x".repeat(400) });
    expect(summary).toBe(`${"x".repeat(300)}…`);
  });
});

describe("ToolPolicy", () => {
  const policy = new ToolPolicy({ workspace: "/ws", overrides: {} });

  it("applies the default decisions", () => {
    expect(policy.decide("read", { path: "/etc/passwd" })).toBe("allow");
    expect(policy.decide("grep", {})).toBe("allow");
    expect(policy.decide("find", {})).toBe("allow");
    expect(policy.decide("bash", { command: "ls" })).toBe("ask");
    expect(policy.decide("mystery", {})).toBe("ask");
  });

  it("allows writes inside the workspace only", () => {
    expect(policy.decide("write", { path: "memory/a.md" })).toBe("allow");
    expect(policy.decide("edit", { path: "/ws/SOUL.md" })).toBe("allow");
    expect(policy.decide("write", { path: "/etc/hosts" })).toBe("ask");
    expect(policy.decide("edit", { path: "../outside.md" })).toBe("ask");
    expect(policy.decide("write", {})).toBe("ask");
  });

  it("lets configuration override everything", () => {
    const custom = new ToolPolicy({ workspace: "/ws", overrides: { bash: "allow", write: "ask", grep: "deny" } });
    expect(custom.decide("bash", { command: "rm -rf /" })).toBe("allow");
    expect(custom.decide("write", { path: "a.md" })).toBe("ask");
    expect(custom.decide("grep", {})).toBe("deny");
  });

  it("filters out denied tools", () => {
    const custom = new ToolPolicy({ workspace: "/ws", overrides: { bash: "deny" } });
    expect(custom.filter([{ name: "read" }, { name: "bash" }]).map((t) => t.name)).toEqual(["read"]);
  });
});
