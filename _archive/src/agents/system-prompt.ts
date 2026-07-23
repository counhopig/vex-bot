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
  /**
   * When true and no explicit `basePrompt` is given, omit the default assistant
   * identity line entirely. Used when a persona (or other injector) supplies the
   * identity, so the base prompt does not assert a competing one.
   */
  omitDefaultIdentity?: boolean;
}

/**
 * Neutral fallback identity. Deliberately language-agnostic and role-agnostic:
 * this is a general chatbot framework, so the default must not claim to be a
 * coding assistant or force English replies.
 */
const DEFAULT_IDENTITY =
  "You are a helpful, friendly AI assistant. Respond in the same language the user writes in.";

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

function buildUnifiedContextSection(options: SystemPromptOptions): string {
  const hasSkills = Boolean(options.skillsPrompt);
  const hasTools = Boolean(options.tools && options.tools.length > 0);
  const hasMemory = Boolean(options.enableMemory || options.tools?.some((t) => t.name === "memory_search"));
  const lines = ["## Unified Capability Context", ""];
  lines.push("- Skills describe durable behavior, domain knowledge, and operating procedures that should guide your responses.");
  if (hasTools) {
    lines.push("- Tools are executable capabilities. Use them when you need current data, local state, file/process access, or a concrete action.");
  }
  if (hasMemory) {
    lines.push("- Memory is shared long-term state across persona, skills, tools, and extensions. Search it before answering personal, historical, preference, or previously-recorded questions; store only durable facts the user explicitly wants remembered.");
  }
  lines.push("- Persona context, retrieved memories, and skill instructions should be reconciled into one coherent answer. If they conflict, prefer the newest explicit user instruction and mention uncertainty when needed.");
  if (!hasSkills && !hasTools && !hasMemory) {
    lines.push("- No extra skills, tools, or long-term memory are currently available.");
  }
  return lines.join("\n");
}

/** Build complete system prompt */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [];

  // Base identity. An explicit basePrompt always wins. Otherwise fall back to a
  // neutral identity — unless omitDefaultIdentity is set, in which case emit no
  // identity line at all (a persona injector supplies it downstream).
  if (options.basePrompt) {
    sections.push(options.basePrompt);
  } else if (!options.omitDefaultIdentity) {
    sections.push(DEFAULT_IDENTITY);
  }

  // Environment info
  if (options.includeEnvironment !== false) {
    sections.push("");
    sections.push(buildEnvironmentSection(options));
  }

  sections.push("");
  sections.push(buildUnifiedContextSection(options));

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
