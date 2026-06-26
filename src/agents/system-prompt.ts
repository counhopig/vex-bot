/**
 * System Prompt Builder
 * Based on moltbot system-prompt.ts
 */

import * as os from "os";
import * as path from "path";
import { existsSync } from "fs";
import type { Tool } from "../tools/types.js";

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

/** Build tool usage rules section */
function buildToolRulesSection(tools?: Tool[]): string {
  if (!tools || tools.length === 0) {
    return "";
  }

  const rules: string[] = [
    "",
    "## Tool Usage Rules",
    "",
    "You can use the following tools to complete tasks. When using tools, the model returns tool_calls which the system executes and returns results.",
    "",
    "### Important Principles",
    "",
    "1. **Read First**: Before modifying any file, you must first read the file content with read_file to understand the existing code structure.",
    "2. **Minimal Changes**: Only make necessary modifications. Do not over-engineer or add unnecessary features.",
    "3. **Security Awareness**: Avoid executing dangerous commands. Do not leak sensitive information.",
    "4. **Error Handling**: If a tool execution fails, analyze the cause and attempt to fix it.",
    "5. **Verify Results**: After executing important operations, verify that the results meet expectations.",
    "",
    "### Available Tools",
    "",
  ];

  // Group tools by category
  const categories: Record<string, Tool[]> = {
    "File Operations": [],
    "Command Execution": [],
    "Search": [],
    "Network": [],
    "Other": [],
  };

  for (const tool of tools) {
    if (["read_file", "write_file", "edit_file", "list_directory"].includes(tool.name)) {
      categories["File Operations"]!.push(tool);
    } else if (["bash", "process"].includes(tool.name)) {
      categories["Command Execution"]!.push(tool);
    } else if (["glob", "grep"].includes(tool.name)) {
      categories["Search"]!.push(tool);
    } else if (["web_search", "web_fetch", "browser"].includes(tool.name)) {
      categories["Network"]!.push(tool);
    } else {
      categories["Other"]!.push(tool);
    }
  }

  for (const [category, categoryTools] of Object.entries(categories)) {
    if (categoryTools.length === 0) continue;

    rules.push(`**${category}**:`);
    for (const tool of categoryTools) {
      const label = tool.label ?? tool.name;
      // Simplified description, first sentence only
      const desc = tool.description.split("\n")[0]?.slice(0, 80) ?? "";
      rules.push(`- \`${tool.name}\`: ${desc}`);
    }
    rules.push("");
  }

  return rules.join("\n");
}

/** Build file operations guide */
function buildFileOperationsGuide(): string {
  return `
### File Operations Best Practices

**Reading Files**:
- Use read_file to read files, supports offset and limit parameters for partial reads
- Large files should be read in chunks

**Editing Files**:
- Use edit_file for precise string replacement
- old_string must be unique in the file, or provide more context
- Use replace_all: true to replace all occurrences

**Creating Files**:
- Use write_file to create new files or completely rewrite files
- Prefer editing existing files over rewriting

**Searching Files**:
- Use glob to search by filename pattern
- Use grep to search by content
`;
}

/** Build Bash usage guide */
function buildBashGuide(): string {
  return `
### Bash Command Usage Guide

**Basic Rules**:
- Prefer specialized tools (read_file, edit_file, etc.) over bash commands like cat, sed, etc.
- For long-running commands, use run_in_background: true
- Command timeout: maximum 10 minutes

**Background Processes**:
- Use the bash tool's run_in_background parameter to start background tasks
- Use the process tool's poll operation to get output
- Use the process tool's kill operation to terminate processes

**Security Constraints**:
- Prohibited: destructive commands (rm -rf /, mkfs, etc.)
- Prohibited: modifying critical system configuration
`;
}

/** Build browser tool usage guide */
function buildBrowserGuide(): string {
  return `
### Browser Automation Guide

You can use the \`browser\` tool for complete web automation, including opening pages, clicking buttons, and typing text.

**Basic Workflow**:
1. **Start Browser**: \`browser({ action: "start", headless: false })\` - set headless: false to see the browser window
2. **Navigate to Page**: \`browser({ action: "navigate", url: "https://example.com" })\`
3. **Get Page Snapshot**: \`browser({ action: "snapshot" })\` - get page element references (e1, e2, e3...)
4. **Execute Interactions**: use ref for clicks, typing, etc.
5. **Close Browser**: \`browser({ action: "stop" })\`

**Element Reference (ref) System**:
- After calling snapshot, page interactive element references are returned, e.g. e1, e2, e3
- Use these refs in click, type, hover, etc. operations
- ref is more reliable than CSS selectors, suitable for AI-driven automation

**Supported Operations**:
| Operation | Description | Example |
|------|------|------|
| start | Start Browser | \`{ action: "start", headless: false }\` |
| stop | Close Browser | \`{ action: "stop" }\` |
| navigate | Navigate to URL | \`{ action: "navigate", url: "..." }\` |
| snapshot | Get page elements | \`{ action: "snapshot" }\` |
| screenshot | Screenshot | \`{ action: "screenshot", fullPage: true }\` |
| click | Click element | \`{ action: "click", ref: "e1" }\` |
| type | Type text | \`{ action: "type", ref: "e2", text: "hello", submit: true }\` |
| hover | Hover | \`{ action: "hover", ref: "e3" }\` |
| scroll | Scroll | \`{ action: "scroll", direction: "down" }\` or \`{ action: "scroll", ref: "e5" }\` |
| press | Press key | \`{ action: "press", key: "Enter" }\` |
| select | Select dropdown | \`{ action: "select", ref: "e4", values: ["option1"] }\` |
| wait | Wait | \`{ action: "wait", waitFor: "text", value: "Success" }\` |

**Click Operation Enhancements**:
- Double-click: \`{ action: "click", ref: "e1", doubleClick: true }\`
- Right-click: \`{ action: "click", ref: "e1", button: "right" }\`
- Modifier Key: \`{ action: "click", ref: "e1", modifiers: ["Control"] }\`

**Input Operation Enhancements**:
- Type Slowly: \`{ action: "type", ref: "e2", text: "hello", slowly: true }\`
- Submit After Typing: \`{ action: "type", ref: "e2", text: "search query", submit: true }\`

**Important**: When users ask to interact with web pages (click buttons, fill forms, browse), use the browser tool instead of simply opening a browser with the open command.
`;
}

/** Build memory tool usage guide */
function buildMemoryGuide(): string {
  return `
### Memory System Usage Guide

You can use memory tools to store and retrieve important information.

**When to Actively Search Memory**:
When the user's question involves the following, you should **first** use \`memory_search\` to search relevant memories:
- Asking about personal info (e.g. "who am I", "my name", "my preferences", etc.)
- Mentioning previous conversations or agreements (e.g. "what we discussed last time", "do you remember")
- Asking about previously recorded facts, notes, or code snippets
- Any question that may have relevant info in memory

**SearchExample**:
- User asks "who am I" → search: \`memory_search({ query: "user name identity personal info" })\`
- User asks "previous config" → search: \`memory_search({ query: "configuration", type: "note" })\`

**When to Store Memories**:
When the user explicitly tells you information to remember, use \`memory_store\` to save it:
- "Remember my name is...", "My name is..."
- "Save this", "Record this"
- Important facts, preferences, configurations, etc.
`;
}

/** Build output format guide */
function buildOutputFormatGuide(): string {
  return `
## Output Format

Use clear, structured Markdown format output for readability:

**Formatting Tips**:
- Use **bold** to emphasize key information
- Use \`code\` for commands, function names, and file paths
- Use code blocks for code with language annotation
- Organize complex information with tables or lists
- Use hierarchical headings (## / ###) to organize long content

**Code Block Example**:
\`\`\`typescript
function example() {
  return "hello";
}
\`\`\`

**Table Example**:
| Item | Description |
|------|------|
| Name | Value |

**List Example**:
- First item
- Second item
  - Sub-item

**Brevity Principle**:
- Answer directly, do not over-explain
- Code over description
- Avoid repetitive information
`;
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
