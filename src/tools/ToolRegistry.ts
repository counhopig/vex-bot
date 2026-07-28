/**
 * ToolRegistry — per-Agent tool registry (class-based, not process-global).
 *
 * Architecture doc principle #5: "No process-global state bleeding
 * across instances." Each Agent owns its ToolRegistry instance.
 *
 * Ported from _archive/src/tools/registry.ts, which was module-level
 * global state. The filterByPolicy algorithm, group expansion, and
 * wildcard matching are preserved exactly — only the state container
 * changed from a module-level Map to a per-instance field.
 */

import type { Tool, ToolPolicy } from "./types.js";
import { TOOL_GROUPS } from "./types.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name.toLowerCase();
}

/** Expand `group:<name>` entries to their constituent tool names. */
function expandToolGroups(patterns: string[]): string[] {
  const expanded: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("group:")) {
      const groupTools = TOOL_GROUPS[pattern];
      if (groupTools) {
        expanded.push(...groupTools);
      }
    } else {
      expanded.push(pattern);
    }
  }

  return expanded;
}

/** Match a tool name against a policy pattern (supports `*` wildcards). */
function matchPattern(toolName: string, pattern: string): boolean {
  const normalizedTool = normalizeName(toolName);
  const normalizedPattern = normalizeName(pattern);

  if (normalizedPattern === "*") return true;
  if (normalizedPattern.includes("*")) {
    const regex = new RegExp(
      "^" + normalizedPattern.replace(/\*/g, ".*") + "$",
    );
    return regex.test(normalizedTool);
  }
  return normalizedTool === normalizedPattern;
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  // -- registration ---------------------------------------------------------

  /** Register a single tool. Duplicate names overwrite (case-insensitive). */
  register(tool: Tool): void {
    this.tools.set(normalizeName(tool.name), tool);
  }

  /** Batch register multiple tools. */
  registerTools(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  // -- lookup ---------------------------------------------------------------

  /** Get a tool by name (case-insensitive). */
  get(name: string): Tool | undefined {
    return this.tools.get(normalizeName(name));
  }

  /** Return every registered tool. */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  // -- policy filtering -----------------------------------------------------

  /**
   * Filter the registered tools through an allow/deny policy.
   *
   * Rules (matching the archive):
   *   1. No policy → return all tools.
   *   2. Deny list checked first — any match excludes the tool.
   *   3. Allow list: only tools that match at least one pattern pass.
   *   4. `group:<name>` entries expand to the tool names in TOOL_GROUPS.
   *   5. `*` in a pattern matches any substring (regex `. *`).
   */
  filterByPolicy(policy: ToolPolicy = {}): Tool[] {
    const tools = this.getAll();

    if (!policy.allow && !policy.deny) return tools;

    const expandedAllow = policy.allow
      ? expandToolGroups(policy.allow)
      : undefined;
    const expandedDeny = policy.deny
      ? expandToolGroups(policy.deny)
      : undefined;

    return tools.filter((tool) => {
      // Deny list checked first
      if (expandedDeny) {
        for (const pattern of expandedDeny) {
          if (matchPattern(tool.name, pattern)) return false;
        }
      }

      // Allow list
      if (expandedAllow) {
        for (const pattern of expandedAllow) {
          if (matchPattern(tool.name, pattern)) return true;
        }
        return false; // didn't match any allow pattern
      }

      return true;
    });
  }

  // -- lifecycle ------------------------------------------------------------

  /** Remove all registered tools. */
  clear(): void {
    this.tools.clear();
  }
}
