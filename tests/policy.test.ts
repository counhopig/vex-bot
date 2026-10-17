import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolPolicy } from "../src/policy/policy.js";
import { summarizeArgs } from "../src/tools/summary.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

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
    for (const tool of ["web_fetch", "web_search", "memory_search", "feel", "schedule", "delegate"]) expect(policy.decide(tool, {})).toBe("allow");
  });

  it("lets the read-only vault tools run without approval", () => {
    expect(policy.decide("vault_search", { query: "x" })).toBe("allow");
    expect(policy.decide("vault_read", { path: "a.md" })).toBe("allow");
    const denying = new ToolPolicy({ workspace: "/ws", overrides: { vault_read: "deny" } });
    expect(denying.filter([{ name: "vault_search" }, { name: "vault_read" }])).toEqual([{ name: "vault_search" }]);
  });

  it("allows writes inside the workspace only", () => {
    expect(policy.decide("write", { path: "memory/a.md" })).toBe("allow");
    expect(policy.decide("edit", { path: "/ws/SOUL.md" })).toBe("allow");
    expect(policy.decide("write", { path: "/etc/hosts" })).toBe("ask");
    expect(policy.decide("edit", { path: "../outside.md" })).toBe("ask");
    expect(policy.decide("write", {})).toBe("ask");
  });

  it("clamps writes and edits out of protected roots even when overridden to allow", () => {
    const vault = "/vault";
    const scoped = new ToolPolicy({ workspace: "/ws", overrides: { write: "allow" }, protectedRoots: [vault] });
    expect(scoped.decide("write", { path: `${vault}/wiki/a.md` })).toBe("deny");
    expect(scoped.decide("edit", { path: `${vault}/raw/b.md` })).toBe("deny");
    expect(scoped.decide("write", { path: `${vault}/notes/x.md` })).toBe("deny");
  });

  it("leaves path decisions unchanged without protected roots", () => {
    const unscoped = new ToolPolicy({ workspace: "/ws", overrides: {} });
    expect(unscoped.decide("write", { path: "memory/a.md" })).toBe("allow");
    expect(unscoped.decide("write", { path: "/vault/wiki/a.md" })).toBe("ask");
  });

  it("asks before wiki bootstrap while allowing the other wiki tools", () => {
    for (const tool of ["wiki_write", "wiki_edit", "wiki_ingest", "wiki_bootstrap", "wiki_rollback"]) {
      expect(policy.decide(tool, {})).toBe(tool === "wiki_bootstrap" ? "ask" : "allow");
    }
  });

  it("still applies deny overrides to the wiki tools", () => {
    const denying = new ToolPolicy({ workspace: "/ws", overrides: { wiki_write: "deny" } });
    expect(denying.decide("wiki_write", {})).toBe("deny");
    expect(denying.filter([{ name: "wiki_write" }, { name: "wiki_edit" }])).toEqual([{ name: "wiki_edit" }]);
  });

  it("lets configuration override everything", () => {
    const custom = new ToolPolicy({ workspace: "/ws", overrides: { bash: "allow", write: "ask", grep: "deny" } });
    expect(custom.decide("bash", { command: "rm -rf /" })).toBe("allow");
    expect(custom.decide("write", { path: "a.md" })).toBe("ask");
    expect(custom.decide("grep", {})).toBe("deny");
  });

  it("asks for existing files and new descendants reached through external symlinks", async () => {
    const dir = await makeTmpDir();
    try {
      const workspace = join(dir, "workspace");
      const outside = join(dir, "outside");
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(join(outside, "file"), "outside");
      await symlink(join(outside, "file"), join(workspace, "linked-file"));
      await symlink(outside, join(workspace, "linked-dir"));
      await symlink(join(outside, "missing"), join(workspace, "dangling"));
      await symlink(workspace, join(dir, "workspace-alias"));
      const scoped = new ToolPolicy({ workspace, overrides: {} });
      expect(scoped.decide("edit", { path: "linked-file" })).toBe("ask");
      expect(scoped.decide("write", { path: "linked-dir/file" })).toBe("ask");
      expect(scoped.decide("write", { path: "linked-dir/new/deeper/file" })).toBe("ask");
      expect(scoped.decide("write", { path: "dangling" })).toBe("ask");
      expect(scoped.decide("write", { path: "new/deeper/file" })).toBe("allow");
      const aliased = new ToolPolicy({ workspace: join(dir, "workspace-alias"), overrides: {} });
      expect(aliased.decide("write", { path: "new/file" })).toBe("allow");
      expect(aliased.decide("edit", { path: "linked-file" })).toBe("ask");
    } finally {
      await removeTmpDir(dir);
    }
  });

  it("filters out denied tools", () => {
    const custom = new ToolPolicy({ workspace: "/ws", overrides: { bash: "deny" } });
    expect(custom.filter([{ name: "read" }, { name: "bash" }]).map((t) => t.name)).toEqual(["read"]);
  });

  it("applies MCP service policy while exact tool policy takes precedence", () => {
    const custom = new ToolPolicy({ workspace: "/ws", overrides: { mcp__browser: "deny", mcp__browser__read: "allow", mcp__other: "allow" } });
    expect(custom.decide("mcp__browser__click", {})).toBe("deny");
    expect(custom.decide("mcp__browser__read", {})).toBe("allow");
    expect(custom.decide("mcp__other__read", {})).toBe("allow");
    expect(custom.decide("mcp__unknown__read", {})).toBe("ask");
    expect(custom.filter([{ name: "mcp__browser__click" }, { name: "mcp__browser__read" }])).toEqual([{ name: "mcp__browser__read" }]);
  });
});
