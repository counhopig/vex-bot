/**
 * System Prompt Builder
 * Based on moltbot system-prompt.ts
 */

import * as os from "os";
import * as path from "path";
import { existsSync } from "fs";
import type { Tool } from "../tools/types.js";
import { buildToolRulesSection, buildFileOperationsGuide, buildBashGuide, buildBrowserGuide, buildMemoryGuide, buildOutputFormatGuide } from "./prompt-guides.js";

const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** System prompt options */
export interface SystemPromptOptions {
  /** Base system prompt */
  basePrompt?: string;
  /** Working directory */
  workingDirectory?: string;
  /** Whether to include environment info */
  includeEnvironment?: boolean;
  /** Whether to include date/time */
  includeDateTime?: boolean;
  timezone?: string;
  /** Whether to include tool usage rules */
  includeToolRules?: boolean;
  /** Available tools list (for tool usage guide generation) */
  tools?: Tool[];
  /** Additional context (e.g. previous summary) */
  additionalContext?: string;
  /** Username */
  userName?: string;
  /** Skills prompt (built by skills registry) */
  skillsPrompt?: string;
  /** Whether memory system is enabled (for injecting memory usage guide) */
  enableMemory?: boolean;
}

/** Get platform info */
function getPlatformInfo(): string {
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();

  const platformNames: Record<string, string> = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  };

  const platformName = platformNames[platform] ?? platform;

  return `${platformName} ${release} (${arch})`;
}

/** Get current date and time */
function getCurrentDateTime(timezone: string): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const timeStr = now.toLocaleTimeString("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${dateStr} ${timeStr}`;
}

/** Get shell info */
function getShellInfo(): string {
  return process.env.SHELL ?? "/bin/bash";
}

/** Build environment info section */
function buildEnvironmentSection(options: SystemPromptOptions): string {
  const cwd = options.workingDirectory ?? process.cwd();
  const sections: string[] = [];

  sections.push(`<environment>`);
  sections.push(`Working directory: ${cwd}`);
  sections.push(`Platform: ${getPlatformInfo()}`);
  sections.push(`Shell: ${getShellInfo()}`);
  sections.push(`Home: ${os.homedir()}`);

  if (options.includeDateTime !== false) {
    const timezone = options.timezone ?? DEFAULT_TIMEZONE;
    sections.push(`Current time (${timezone}): ${getCurrentDateTime(timezone)}`);
  }

  // Check if git repository
  if (existsSync(path.join(cwd, ".git"))) {
    sections.push(`Git repository: Yes`);
  }

  if (options.userName) {
    sections.push(`User: ${options.userName}`);
  }

  sections.push(`</environment>`);

  return sections.join("\n");
}

/** Build complete system prompt */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [];

  // Base prompt
  const basePrompt = options.basePrompt ??
    "You are an intelligent programming assistant that helps users with various software development tasks. Please respond in English. Code and commands should use English.";

  sections.push(basePrompt);

  // Environment info
  if (options.includeEnvironment !== false) {
    sections.push("");
    sections.push(buildEnvironmentSection(options));
  }

  // Tool usage rules
  if (options.includeToolRules !== false && options.tools && options.tools.length > 0) {
    sections.push(buildToolRulesSection(options.tools));
    sections.push(buildFileOperationsGuide());
    sections.push(buildBashGuide());

    // If browser tool is available, add browser usage guide
    if (options.tools.some((t) => t.name === "browser")) {
      sections.push(buildBrowserGuide());
    }

    // If memory tool is available, add memory usage guide
    if (options.tools.some((t) => t.name === "memory_search")) {
      sections.push(buildMemoryGuide());
    }
  }

  // Under native function calling mode, inject memory guide separately
  if (options.enableMemory && !(options.tools?.some((t) => t.name === "memory_search"))) {
    sections.push(buildMemoryGuide());
  }

  // Skills prompt
  if (options.skillsPrompt) {
    sections.push("");
    sections.push(options.skillsPrompt);
  }

  // Output format guide
  sections.push(buildOutputFormatGuide());

  // Additional context
  if (options.additionalContext) {
    sections.push("");
    sections.push("## Previous Conversation Summary");
    sections.push("");
    sections.push(options.additionalContext);
  }

  return sections.join("\n").trim();
}

/** Create default system prompt */
export function createDefaultSystemPrompt(tools?: Tool[]): string {
  return buildSystemPrompt({
    includeEnvironment: true,
    includeDateTime: true,
    includeToolRules: true,
    tools,
  });
}
