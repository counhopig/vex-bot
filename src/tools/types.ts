/**
 * Tool system - type definitions
 * Uses pi-agent-core AgentTool type
 */

import type { TSchema, Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

// Re-export AgentTool as Tool type
export type Tool<TParameters extends TSchema = TSchema, TDetails = unknown> = AgentTool<TParameters, TDetails>;

/** Tool result content item */
export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Tool execution result */
export interface ToolResult {
  content: ToolResultContent[];
  details?: unknown;
  isError?: boolean;
}

/** Tool update callback */
export type ToolUpdateCallback = (partial: { text?: string }) => void;

/** Tool call */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool call result */
export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: ToolResult;
  isError: boolean;
  durationMs: number;
}

/** Tool policy */
export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

/** Tool group definition */
export const TOOL_GROUPS: Record<string, string[]> = {
  "group:web": ["web_search", "web_fetch"],
  "group:memory": ["memory_search", "memory_store"],
  "group:media": ["image_analyze"],
  "group:system": ["current_time", "calculator"],
};

/** Create an AgentTool result */
export function createToolResult(
  text: string,
  details?: unknown,
  isError = false
): AgentToolResult<unknown> & { isError?: boolean } {
  return {
    content: [{ type: "text", text }],
    details: details ?? {},
    isError,
  };
}

/** Create an error result */
export function createErrorToolResult(error: string): AgentToolResult<unknown> & { isError: true } {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", error }, null, 2) }],
    details: { status: "error", error },
    isError: true,
  };
}
