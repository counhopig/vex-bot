import type { Decision } from "../config/schema.js";
import { isInside, resolveToolPath } from "../tools/paths.js";

export const DEFAULT_DECISIONS: Record<string, Decision> = {
  read: "allow",
  grep: "allow",
  find: "allow",
  bash: "ask",
};

const PATH_SCOPED_TOOLS = new Set(["write", "edit"]);

export class ToolPolicy {
  private readonly workspace: string;
  private readonly overrides: Record<string, Decision>;

  constructor(opts: { workspace: string; overrides: Record<string, Decision> }) {
    this.workspace = opts.workspace;
    this.overrides = opts.overrides;
  }

  decide(toolName: string, args: unknown): Decision {
    const override = this.overrides[toolName];
    if (override) return override;
    if (PATH_SCOPED_TOOLS.has(toolName)) return this.decideByPath(args);
    return DEFAULT_DECISIONS[toolName] ?? "ask";
  }

  filter<T extends { name: string }>(tools: T[]): T[] {
    return tools.filter((tool) => this.overrides[tool.name] !== "deny");
  }

  private decideByPath(args: unknown): Decision {
    const path = args && typeof args === "object" ? (args as Record<string, unknown>).path : undefined;
    if (typeof path !== "string") return "ask";
    return isInside(this.workspace, resolveToolPath(this.workspace, path)) ? "allow" : "ask";
  }
}
