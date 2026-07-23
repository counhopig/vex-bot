/**
 * Tool registry (simplified)
 * Used by the plugin system to register custom tools
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Tool, ToolPolicy } from "./types.js";
import { TOOL_GROUPS } from "./types.js";

// Tool registry (case-insensitive keys)
const toolRegistry = new Map<string, AgentTool>();

/** Normalize tool name (lowercase) */
function normalizeName(name: string): string {
  return name.toLowerCase();
}

/** Register a single tool */
export function registerTool(tool: Tool): void {
  const normalizedName = normalizeName(tool.name);
  toolRegistry.set(normalizedName, tool as AgentTool);
}

/** Batch register tools */
export function registerTools(tools: Tool[]): void {
  for (const tool of tools) {
    registerTool(tool);
  }
}

/** Get a tool (case-insensitive) */
export function getTool(name: string): AgentTool | undefined {
  return toolRegistry.get(normalizeName(name));
}

/** Get all tools */
export function getAllTools(): AgentTool[] {
  return Array.from(toolRegistry.values());
}

/** Clear the registry */
export function clearTools(): void {
  toolRegistry.clear();
}

/** Expand tool groups */
function expandToolGroups(patterns: string[]): string[] {
  const expanded: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("group:")) {
      // TOOL_GROUPS keys include "group:" prefix
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

/** Match wildcard pattern */
function matchPattern(toolName: string, pattern: string): boolean {
  const normalizedTool = normalizeName(toolName);
  const normalizedPattern = normalizeName(pattern);

  if (normalizedPattern === "*") return true;
  if (normalizedPattern.includes("*")) {
    const regex = new RegExp("^" + normalizedPattern.replace(/\*/g, ".*") + "$");
    return regex.test(normalizedTool);
  }
  return normalizedTool === normalizedPattern;
}

/**
 * Filter tools by policy
 */
export function filterToolsByPolicy(tools: AgentTool[], policy: ToolPolicy = {}): AgentTool[] {
  if (!policy.allow && !policy.deny) return tools;

  const expandedAllow = policy.allow ? expandToolGroups(policy.allow) : undefined;
  const expandedDeny = policy.deny ? expandToolGroups(policy.deny) : undefined;

  return tools.filter((tool) => {
    // Check deny list
    if (expandedDeny) {
      for (const pattern of expandedDeny) {
        if (matchPattern(tool.name, pattern)) return false;
      }
    }

    // Check allow list
    if (expandedAllow) {
      for (const pattern of expandedAllow) {
        if (matchPattern(tool.name, pattern)) return true;
      }
      return false;
    }

    return true;
  });
}

/**
 * Execute tool calls (placeholder; actual execution is handled by pi-coding-agent)
 */
export async function executeToolCalls(
  _toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  _tools: AgentTool[]
): Promise<Array<{ toolCallId: string; name: string; result: unknown; isError: boolean }>> {
  // Actual execution is handled by the pi-coding-agent framework
  return [];
}

/**
 * Convert tools to OpenAI Functions format
 */
export function toolsToOpenAIFunctions(tools: AgentTool[]): Array<{ type: string; function: { name: string; description: string; parameters: unknown } }> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}