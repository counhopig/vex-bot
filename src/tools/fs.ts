import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { displayPath, resolveToolPath } from "./paths.js";

const ReadParams = Type.Object({
  path: Type.String({ description: "File path; relative paths resolve inside the workspace" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line number (starting at 1)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read; default 2000" })),
});

export function createReadTool(workspace: string): AgentTool<typeof ReadParams> {
  return {
    name: "read",
    label: "Read file",
    description: "Reads a text file, with a line number before each line.",
    parameters: ReadParams,
    async execute(_id, { path, offset = 1, limit = 2000 }) {
      const abs = resolveToolPath(workspace, path);
      const lines = (await readFile(abs, "utf8")).split("\n");
      const start = offset - 1;
      const body = lines
        .slice(start, start + limit)
        .map((line, i) => `${offset + i}\t${line}`)
        .join("\n");
      const more = start + limit < lines.length ? `\n… (${lines.length} lines in total; use offset to continue reading)` : "";
      return { content: [{ type: "text", text: body + more }], details: { path: abs } };
    },
  };
}

const WriteParams = Type.Object({
  path: Type.String({ description: "File path; relative paths resolve inside the workspace" }),
  content: Type.String({ description: "Complete file content" }),
});

export function createWriteTool(workspace: string): AgentTool<typeof WriteParams> {
  return {
    name: "write",
    label: "Write file",
    description: "Writes the complete file content, overwriting an existing file and creating missing parent directories.",
    parameters: WriteParams,
    async execute(_id, { path, content }) {
      const abs = resolveToolPath(workspace, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      return {
        content: [{ type: "text", text: `Wrote ${displayPath(workspace, abs)} (${bytes} bytes)` }],
        details: { path: abs },
      };
    },
  };
}

const EditParams = Type.Object({
  path: Type.String({ description: "File path; relative paths resolve inside the workspace" }),
  oldText: Type.String({ description: "Text to replace; it must match the file content exactly" }),
  newText: Type.String({ description: "Replacement text" }),
  replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence; by default only a unique match is allowed" })),
});

export function createEditTool(workspace: string): AgentTool<typeof EditParams> {
  return {
    name: "edit",
    label: "Edit file",
    description: "Replaces oldText in the file with newText exactly. oldText must occur once unless replaceAll is set.",
    parameters: EditParams,
    async execute(_id, { path, oldText, newText, replaceAll = false }) {
      if (oldText === "") throw new Error("oldText must not be empty");
      const abs = resolveToolPath(workspace, path);
      const original = await readFile(abs, "utf8");
      const count = original.split(oldText).length - 1;
      if (count === 0) throw new Error(`oldText was not found in ${displayPath(workspace, abs)}`);
      if (count > 1 && !replaceAll) {
        throw new Error(`oldText occurs ${count} times; add more context to make it unique, or set replaceAll`);
      }
      const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, () => newText);
      await writeFile(abs, updated, "utf8");
      return {
        content: [{ type: "text", text: `Edited ${displayPath(workspace, abs)} (${replaceAll ? count : 1} replacement(s))` }],
        details: { path: abs },
      };
    },
  };
}
