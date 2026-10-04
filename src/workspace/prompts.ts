import { readWorkspaceFile } from "./workspace.js";

/** Prompt files the owner can edit in the workspace; the built-in text is used while a file is missing or empty. */
export const PROMPT_FILES = ["prompts/consolidation.md", "prompts/outreach.md"] as const;
export type PromptFile = (typeof PROMPT_FILES)[number];

const MAX_PROMPT_CHARS = 30_000;

export const DEFAULT_PROMPTS: Record<PromptFile, string> = {
  "prompts/consolidation.md": [
    "Read the daily notes of the last seven days ({{dates}}; skip files that do not exist), plus MEMORY.md and USER.md.",
    "Distil what recurs or is clearly important into MEMORY.md and USER.md, merge duplicate entries, remove stale ones, and keep MEMORY.md under 100 lines.",
    "Edit only files inside the workspace and send no message to the owner.",
    "",
  ].join("\n"),
  "prompts/outreach.md": [
    "Proactive chat: given your current mood, the time of day and your memory, naturally start a conversation.",
    "Open a new topic. Do not repeat or resend earlier messages, reminders or greetings from the conversation history.",
    "Address the owner as USER.md or SOUL.md says.",
    "",
  ].join("\n"),
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
