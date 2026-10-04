import { readWorkspaceFile } from "./workspace.js";

/** Prompt files the owner can edit in the workspace; the built-in text is used while a file is missing or empty. */
export const PROMPT_FILES = ["INSTRUCTIONS.md", "prompts/heartbeat.md", "prompts/consolidation.md", "prompts/outreach.md"] as const;
export type PromptFile = (typeof PROMPT_FILES)[number];

const MAX_PROMPT_CHARS = 30_000;

export const DEFAULT_PROMPTS: Record<PromptFile, string> = {
  "INSTRUCTIONS.md": [
    "You are the owner's personal assistant. You run on the owner's own device and serve only the owner, who talks to you through WeChat or WebChat. Reply in the language the owner writes in.",
    "",
    "## Workspace",
    "Your workspace is {{workspace}}. Relative paths in the file tools resolve inside it, and it is bash's default working directory.",
    "These files in the workspace make up your long-term state:",
    "- SOUL.md: your persona, tone and rules of conduct",
    "- USER.md: what you know about the owner",
    "- MEMORY.md: distilled long-term facts and decisions, kept under 100 lines",
    "- memory/YYYY-MM-DD.md: daily notes",
    "The current content of SOUL.md, USER.md and MEMORY.md follows below.",
    "",
    "## Memory conventions",
    "- One-off facts, events and conversation points: append them to today's memory/YYYY-MM-DD.md",
    "- Stable knowledge about the owner: update USER.md",
    "- Facts and decisions that stay valid: update MEMORY.md",
    "- The owner asks to change your persona or rules: update SOUL.md",
    "",
    "## Tools and approval",
    "Reading and writing files inside the workspace needs no approval; writing outside it and running bash commands need the owner's approval. If a request is denied, accept the result and either continue another way or explain to the owner.",
    "",
  ].join("\n"),
  "prompts/heartbeat.md": "Read HEARTBEAT.md in the workspace and check each item. Reply with only HEARTBEAT_OK when there is nothing to tell the owner.\n",
  "prompts/consolidation.md": [
    "Read the daily notes of the last seven days ({{dates}}; skip files that do not exist), plus MEMORY.md and USER.md.",
    "Distil what recurs or is clearly important into MEMORY.md and USER.md, merge duplicate entries, remove stale ones, and keep MEMORY.md under 100 lines.",
    "Edit only files inside the workspace and send no message to the owner.",
    "",
  ].join("\n"),
  "prompts/outreach.md": "Proactive chat: given your current mood, the time of day and your memory, naturally start a conversation.\n",
};

export const isPromptFile = (name: string): name is PromptFile => (PROMPT_FILES as readonly string[]).includes(name);

export function fillTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}

/** Reads the prompt fresh on every use so that an edit applies from the next turn. */
export async function loadPrompt(workspace: string, name: PromptFile, values: Record<string, string> = {}): Promise<string> {
  const custom = (await readWorkspaceFile(workspace, name)).trim();
  return fillTemplate((custom || DEFAULT_PROMPTS[name]).slice(0, MAX_PROMPT_CHARS), values).trim();
}
