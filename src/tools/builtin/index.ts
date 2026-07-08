/**
 * Built-in tools export
 */

export * from "./web.js";
export * from "./system.js";
export * from "./image.js";
export * from "./browser.js";
export * from "./filesystem.js";
export * from "./bash.js";
export * from "./process-registry.js";
export * from "./process-tool.js";
export * from "./apply-patch.js";
export * from "./subagent.js";
export * from "./memory.js";
export * from "./cron.js";
export * from "./sharelink.js";
export * from "./weather.js";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createWebSearchTool, createWebFetchTool } from "./web.js";
import { createCurrentTimeTool, createCalculatorTool, createDelayTool } from "./system.js";
import { createImageAnalyzeTool, type ImageAnalyzeToolOptions } from "./image.js";
import { createBrowserTool } from "./browser.js";
import { createFilesystemTools, type FilesystemToolsOptions } from "./filesystem.js";
import { createBashTool, type BashToolOptions } from "./bash.js";
import { createProcessTool } from "./process-tool.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createMemoryTools, type MemoryToolsOptions } from "./memory.js";
import { createCronTools, type CronToolsOptions } from "./cron.js";
import { createShareLinkTool } from "./sharelink.js";
import { createWeatherTool, type WeatherToolOptions } from "./weather.js";
import type { MemoryManager } from "../../memory/index.js";
import type { CronService } from "../../cron/service.js";
import type { ShareLinkConfig } from "../../types/index.js";

/** Built-in tools options */
export interface BuiltinToolsOptions {
  image?: ImageAnalyzeToolOptions;
  filesystem?: FilesystemToolsOptions;
  bash?: BashToolOptions;
  memory?: MemoryToolsOptions;
  weather?: WeatherToolOptions;
  sharelink?: ShareLinkConfig;
  enableBrowser?: boolean;
  enableFilesystem?: boolean;
  enableBash?: boolean;
  enableProcess?: boolean;
  enableMemory?: boolean;
  enableCron?: boolean;
  /** MemoryManager instance */
  memoryManager?: MemoryManager;
  /** CronService instance */
  cronService?: CronService;
}

/** Create all built-in tools */
export function createBuiltinTools(options?: BuiltinToolsOptions): AgentTool[] {
  const tools: AgentTool[] = [
    createCurrentTimeTool(),
    createCalculatorTool(),
    createWebSearchTool(),
    createWebFetchTool(),
    createImageAnalyzeTool(options?.image),
    createDelayTool(),
    createShareLinkTool(options?.sharelink),
    createWeatherTool(options?.weather),
  ];

  // File system tools (enabled by default)
  if (options?.enableFilesystem !== false) {
    tools.push(...createFilesystemTools(options?.filesystem));
  }

  // Bash tool (enabled by default)
  if (options?.enableBash !== false) {
    tools.push(createBashTool(options?.bash));
  }

  // Process management tool (enabled by default, alongside Bash tool)
  if (options?.enableProcess !== false && options?.enableBash !== false) {
    tools.push(createProcessTool());
  }

  // apply_patch tool (enabled by default)
  if (options?.enableFilesystem !== false) {
    const allowedPaths = options?.filesystem?.allowedPaths ?? [process.cwd()];
    tools.push(createApplyPatchTool(allowedPaths));
  }

  // Browser tool is optional, as it requires playwright-core to be installed
  if (options?.enableBrowser) {
    tools.push(createBrowserTool());
  }

  // Memory tools (require MemoryManager instance)
  if (options?.enableMemory !== false && options?.memoryManager) {
    tools.push(...createMemoryTools({ manager: options.memoryManager }));
  }

  // Cron tools (require CronService instance)
  if (options?.enableCron && options?.cronService) {
    tools.push(...createCronTools({ service: options.cronService }));
  }

  return tools;
}
