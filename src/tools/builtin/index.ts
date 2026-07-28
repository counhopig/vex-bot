/**
 * Built-in tools barrel — exports every tool factory.
 *
 * createBuiltinTools(options) assembles the complete tool set,
 * mirroring _archive/src/tools/builtin/index.ts.
 */

export * from "./web.js";
export * from "./system.js";
export * from "./filesystem.js";
export * from "./bash.js";
export * from "./process-registry.js";
export * from "./browser.js";

// ---------------------------------------------------------------------------
// Tool assembly
// ---------------------------------------------------------------------------

import type { Tool } from "../types.js";
import { createWebSearchTool, createWebFetchTool } from "./web.js";
import {
  createCurrentTimeTool,
  createCalculatorTool,
  createDelayTool,
} from "./system.js";
import { createFilesystemTools, type FilesystemToolsOptions } from "./filesystem.js";
import { createBashTools, type BashToolOptions } from "./bash.js";
import { createBrowserTool, disposeAllBrowsers, disposeBrowserOwner } from "./browser.js";
import { disposeOwnerSessions, GLOBAL_OWNER_KEY } from "./process-registry.js";

// ---------------------------------------------------------------------------
// Lazy-loadable optional tools (import type only — these modules depend on
// subsystems that are not yet ported or that provide instances at runtime)
// ---------------------------------------------------------------------------

/** Options for building the built-in tool set. */
export interface BuiltinToolsOptions {
  image?: Record<string, unknown>;
  filesystem?: FilesystemToolsOptions;
  bash?: BashToolOptions;
  memory?: Record<string, unknown>;
  weather?: Record<string, unknown>;
  sharelink?: Record<string, unknown>;
  enableBrowser?: boolean;
  enableFilesystem?: boolean;
  enableBash?: boolean;
  enableProcess?: boolean;
  enableMemory?: boolean;
  enableCron?: boolean;
  /** MemoryManager instance (optional — tools become "disabled" without it). */
  memoryManager?: unknown;
  /** CronService instance (optional). */
  cronService?: unknown;
  /** Owner key isolating the background-process registry per user. */
  owner?: string;
}

/** Create all built-in tools. The always-available tools are included
 *  unconditionally; optional tools are gated by their enable flags. */
export function createBuiltinTools(
  options?: BuiltinToolsOptions,
): Tool[] {
  const owner = options?.owner ?? GLOBAL_OWNER_KEY;
  const tools: Tool[] = [
    createCurrentTimeTool(),
    createCalculatorTool(),
    createWebSearchTool(),
    createWebFetchTool(),
    createDelayTool(),
  ];

  // File system tools (enabled by default)
  if (options?.enableFilesystem !== false) {
    tools.push(...createFilesystemTools(options?.filesystem));
  }

  // Bash tool (enabled by default)
  if (options?.enableBash !== false) {
    tools.push(
      ...createBashTools({
        ...options?.bash,
        owner: options?.owner ?? options?.bash?.owner,
      }),
    );
  }

  // Process management (alongside bash)
  if (options?.enableProcess !== false && options?.enableBash !== false) {
    // process-tool.ts not yet ported — skip for now
  }

  // Browser (opt-in, requires playwright-core)
  if (options?.enableBrowser) {
    tools.push(createBrowserTool(owner));
  }

  // Image analyze, weather, memory, cron, sharelink tools — ported by
  // separate sub-tickets; add them here once their modules land.

  return tools;
}

/** Kill every background process and browser session for a specific owner. */
export async function disposeOwnerResources(ownerKey: string): Promise<void> {
  disposeOwnerSessions(ownerKey);
  await disposeBrowserOwner(ownerKey);
}

/** Kill every background process and browser session (global shutdown). */
export async function disposeAllResources(): Promise<void> {
  disposeOwnerSessions(GLOBAL_OWNER_KEY);
  await disposeAllBrowsers();
}
