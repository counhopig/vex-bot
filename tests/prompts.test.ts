import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseInstructionsSection } from "../src/context/prompt.js";
import { parseClientMessage } from "../src/protocol/messages.js";
import { DEFAULT_PROMPTS, fillTemplate, isPromptFile, loadPrompt, PROMPT_FILES } from "../src/workspace/prompts.js";
import { ensureWorkspace } from "../src/workspace/workspace.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });
const ctx = { windowLabel: "WebChat", now: new Date() };

describe("editable prompts", () => {
  it("falls back to the built-in text while a file is missing or blank", async () => {
    expect(await loadPrompt(dir, "prompts/outreach.md")).toBe(DEFAULT_PROMPTS["prompts/outreach.md"].trim());
    await mkdir(join(dir, "prompts"), { recursive: true });
    await writeFile(join(dir, "prompts", "outreach.md"), "  \n");
    expect(await loadPrompt(dir, "prompts/outreach.md")).toBe(DEFAULT_PROMPTS["prompts/outreach.md"].trim());
  });

  it("uses the owner's text and fills known placeholders only", async () => {
    await mkdir(join(dir, "prompts"), { recursive: true });
    await writeFile(join(dir, "prompts", "consolidation.md"), "Notes: {{dates}} in {{where}}\n");
    expect(await loadPrompt(dir, "prompts/consolidation.md", { dates: "a, b" })).toBe("Notes: a, b in {{where}}");
    expect(fillTemplate("{{x}} {{x}}", { x: "1" })).toBe("1 1");
  });

  it("re-reads the system instructions on every build", async () => {
    const section = baseInstructionsSection(dir);
    expect(await section(ctx)).toContain(`Your workspace is ${dir}.`);
    await writeFile(join(dir, "INSTRUCTIONS.md"), "Be brief in {{workspace}}.");
    expect(await section(ctx)).toBe(`Be brief in ${dir}.`);
    await writeFile(join(dir, "INSTRUCTIONS.md"), "Changed rules.");
    expect(await section(ctx)).toBe("Changed rules.");
  });

  it("seeds every prompt file without overwriting the owner's edits", async () => {
    await ensureWorkspace(dir);
    for (const name of PROMPT_FILES) expect(await readFile(join(dir, name), "utf8")).toBe(DEFAULT_PROMPTS[name]);
    await writeFile(join(dir, "INSTRUCTIONS.md"), "mine");
    await ensureWorkspace(dir);
    expect(await readFile(join(dir, "INSTRUCTIONS.md"), "utf8")).toBe("mine");
  });

  it("recognises prompt files and lets the editor open and save exactly those", () => {
    expect(isPromptFile("INSTRUCTIONS.md")).toBe(true);
    expect(isPromptFile("SOUL.md")).toBe(false);
    for (const name of PROMPT_FILES) {
      expect(parseClientMessage(JSON.stringify({ type: "get_file", name }))).toBeDefined();
      expect(parseClientMessage(JSON.stringify({ type: "save_file", name, text: "x" }))).toBeDefined();
    }
    expect(parseClientMessage(JSON.stringify({ type: "get_file", name: "prompts/other.md" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "get_file", name: "../INSTRUCTIONS.md" }))).toBeUndefined();
  });
});
