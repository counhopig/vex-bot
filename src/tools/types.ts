/**
 * Tool system — type definitions.
 *
 * Re-exports ToolDefinition (the type pi-coding-agent's createAgentSession
 * accepts as customTools) and AgentToolResult from
 * @mariozechner/pi-coding-agent so every tool in this module speaks the
 * same type as the runtime.
 */

import type {
  ToolDefinition,
  AgentToolResult,
} from "@mariozechner/pi-coding-agent";
import type { TSchema, Static } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type Tool<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
> = ToolDefinition<TParams, TDetails>;

export type ToolResult<T = unknown> = AgentToolResult<T>;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Allow- or deny-list of tools (supports `group:<name>` entries
 *  from TOOL_GROUPS and `*` wildcard patterns). */
export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

// ---------------------------------------------------------------------------
// Tool groups
// ---------------------------------------------------------------------------

/** Named groups for policy expansion — `group:web` expands to the listed
 *  tool names so users don't have to enumerate every individual tool. */
export const TOOL_GROUPS: Record<string, string[]> = {
  "group:web": ["web_search", "web_fetch", "weather"],
  "group:memory": ["memory_search", "memory_store"],
  "group:media": ["image_analyze"],
  "group:system": ["current_time", "calculator"],
};

// ---------------------------------------------------------------------------
// Result helpers (kept small — common.ts has the richer variants)
// ---------------------------------------------------------------------------

/** Create a minimal AgentToolResult with a text block. */
export function createToolResult(
  text: string,
  details?: unknown,
  isError = false,
): ToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: details ?? {},
    isError,
  } as ToolResult<unknown>;
}

/** Create an error-formatted AgentToolResult. */
export function createErrorToolResult(error: string): ToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ status: "error", error }, null, 2),
      },
    ],
    details: { status: "error", error },
    isError: true,
  } as ToolResult<unknown>;
}
