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
import { createMemoryTools, type MemoryToolsOptions } from "./memory.js";
import { createWeatherTool, type WeatherToolOptions } from "./weather.js";
import { createCronTools, type CronToolsOptions } from "./cron.js";
import { createImageAnalyzeTool, type ImageAnalyzeToolOptions } from "./image.js";
import type { MemoryManager } from "../../memory/MemoryManager.js";
import type { CronService } from "../../cron/service.js";

// ---------------------------------------------------------------------------
// Lazy-loadable optional tools (import type only — these modules depend on
// subsystems that are not yet ported or that provide instances at runtime)
// ---------------------------------------------------------------------------

/** Options for building the built-in tool set. */
export interface BuiltinToolsOptions {
  image?: ImageAnalyzeToolOptions;
  filesystem?: FilesystemToolsOptions;
  bash?: BashToolOptions;
  memory?: MemoryToolsOptions;
  weather?: WeatherToolOptions;
  enableBrowser?: boolean;
  enableFilesystem?: boolean;
  enableBash?: boolean;
  enableProcess?: boolean;
  enableMemory?: boolean;
  enableCron?: boolean;
  /** MemoryManager instance (optional — tools become "disabled" without it). */
  memoryManager?: MemoryManager;
  /** CronService instance (optional). */
  cronService?: CronService;
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

  // Image analyze tool (always available; gated on vision model availability)
  tools.push(createImageAnalyzeTool({
    ...options?.image,
    allowedPaths: options?.image?.allowedPaths ?? options?.filesystem?.allowedPaths,
  }));

  // Weather tool (always available; wttr default needs no API key, so
  // zero-config works — matches archive's unconditional inclusion).
  tools.push(createWeatherTool(options?.weather));

  // Browser (opt-in, requires playwright-core)
  if (options?.enableBrowser) {
    tools.push(createBrowserTool(owner));
  }

  // Memory tools (enabled by default; without a MemoryManager instance the
  // tools degrade to "disabled" — a tested behavior, not an error).
  if (options?.enableMemory !== false) {
    tools.push(...createMemoryTools({ manager: options?.memoryManager }));
  }

  // Cron tools (enabled by default; without a CronService instance the tools
  // degrade to "disabled" — a tested behavior, not an error).
  if (options?.enableCron !== false) {
    tools.push(...createCronTools({ service: options?.cronService }));
  }

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
