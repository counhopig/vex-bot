import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Decision } from "../config/schema.js";
import { isInside, resolveToolPath } from "../tools/paths.js";

export const DEFAULT_DECISIONS: Record<string, Decision> = {
  read: "allow",
  grep: "allow",
  find: "allow",
  web_fetch: "allow", web_search: "allow", memory_search: "allow", vault_search: "allow", vault_read: "allow", feel: "allow", schedule: "allow", delegate: "allow",
  wiki_write: "allow", wiki_edit: "allow", wiki_ingest: "allow", wiki_bootstrap: "allow", wiki_rollback: "allow",
  bash: "ask",
};

const PATH_SCOPED_TOOLS = new Set(["write", "edit"]);

export class ToolPolicy {
  private readonly workspace: string;
  private readonly overrides: Record<string, Decision>;
  private readonly protectedRoots: string[];

  constructor(opts: { workspace: string; overrides: Record<string, Decision>; protectedRoots?: string[] }) {
    this.workspace = opts.workspace;
    this.overrides = opts.overrides;
    this.protectedRoots = opts.protectedRoots ?? [];
  }

  decide(toolName: string, args: unknown): Decision {
    if (PATH_SCOPED_TOOLS.has(toolName) && this.insideProtectedRoot(args)) return "deny";
    const override = this.override(toolName);
    if (override) return override;
    if (PATH_SCOPED_TOOLS.has(toolName)) return this.decideByPath(args);
    return DEFAULT_DECISIONS[toolName] ?? "ask";
  }

  filter<T extends { name: string }>(tools: T[]): T[] {
    return tools.filter((tool) => this.override(tool.name) !== "deny");
  }

  private override(toolName: string): Decision | undefined {
    return this.overrides[toolName] ?? (toolName.startsWith("mcp__") ? this.overrides[toolName.split("__").slice(0, 2).join("__")] : undefined);
  }

  private decideByPath(args: unknown): Decision {
    const path = args && typeof args === "object" ? (args as Record<string, unknown>).path : undefined;
    if (typeof path !== "string") return "ask";
    try {
      return isInside(resolveRealPath(this.workspace), resolveRealPath(resolveToolPath(this.workspace, path))) ? "allow" : "ask";
    } catch {
      return "ask";
    }
  }

  private insideProtectedRoot(args: unknown): boolean {
    if (this.protectedRoots.length === 0) return false;
    const path = args && typeof args === "object" ? (args as Record<string, unknown>).path : undefined;
    if (typeof path !== "string") return false;
    const target = resolveToolPath(this.workspace, path);
    return this.protectedRoots.some((root) => {
      const lexicalRoot = resolveToolPath(this.workspace, root);
      try {
        return isInside(resolveRealPath(lexicalRoot), resolveRealPath(target));
      } catch {
        return isInside(lexicalRoot, target);
      }
    });
  }
}

function resolveRealPath(path: string): string {
  const remaining: string[] = [];
  let ancestor = path;
  for (;;) {
    try {
      return join(realpathSync(ancestor), ...remaining);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // An existing, dangling symlink cannot be treated as a new path segment.
      let exists = false;
      try {
        lstatSync(ancestor);
        exists = true;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") throw statErr;
      }
      if (exists) throw err;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw err;
      remaining.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}
