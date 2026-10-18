import { open, readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { writeFileAtomic } from "../store/atomic.js";
import { withFileLock } from "../store/fileLock.js";
import { assertMemoryFileLimits } from "../workspace/workspace.js";
import { displayPath, resolveToolPath } from "./paths.js";

const READ_LIMIT = 1_000_000;

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
    async execute(_id, { path, offset = 1, limit = 2000 }, signal) {
      const abs = resolveToolPath(workspace, path);
      signal?.throwIfAborted();
      const handle = await open(abs, "r");
      const lines: string[] = [];
      let more = false;
      try {
        const chunk = Buffer.alloc(65_536);
        let parts: Buffer[] = [];
        let lineNumber = 1;
        let lineBytes = 0;
        let outputBytes = 0;
        let position = 0;
        scan: for (;;) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          const data = chunk.subarray(0, bytesRead);
          let start = 0;
          while (start < bytesRead) {
            const newline = data.indexOf(10, start);
            const end = newline === -1 ? bytesRead : newline;
            if (lineNumber >= offset) {
              lineBytes += end - start;
              if (outputBytes + lineBytes > READ_LIMIT) {
                if (!lines.length) throw new Error(`Line ${lineNumber} exceeds the read limit of 1 MB; use a targeted search or bounded shell command`);
                more = true;
                break scan;
              }
              parts.push(Buffer.from(data.subarray(start, end)));
            }
            if (newline === -1) break;
            if (lineNumber >= offset) {
              lines.push(Buffer.concat(parts).toString("utf8"));
              outputBytes += lineBytes;
              parts = [];
              lineBytes = 0;
              if (lines.length === limit) { more = true; break scan; }
            }
            lineNumber++;
            start = newline + 1;
          }
        }
        if (!more && lineNumber >= offset) lines.push(Buffer.concat(parts).toString("utf8"));
      } finally { await handle.close(); }
      signal?.throwIfAborted();
      const body = lines.map((line, i) => `${offset + i}\t${line}`).join("\n");
      const hint = more ? `\n… (use offset ${offset + lines.length} to continue reading)` : "";
      return { content: [{ type: "text", text: body + hint }], details: { path: abs } };
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
      await withFileLock(abs, async (target) => {
        const previous = await readFile(target, "utf8").catch(() => undefined);
        assertMemoryFileLimits(workspace, abs, content, previous);
        await writeFileAtomic(target, content);
      });
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
      // The whole read-replace-write holds the file's lock, so concurrent edits from
      // other calls, sessions or background runs apply one after another.
      const count = await withFileLock(abs, async (target) => {
        const original = await readFile(target, "utf8");
        const found = original.split(oldText).length - 1;
        if (found === 0) throw new Error(`oldText was not found in ${displayPath(workspace, abs)}`);
        if (found > 1 && !replaceAll) {
          throw new Error(`oldText occurs ${found} times; add more context to make it unique, or set replaceAll`);
        }
        const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, () => newText);
        assertMemoryFileLimits(workspace, abs, updated, original);
        await writeFileAtomic(target, updated);
        return found;
      });
      return {
        content: [{ type: "text", text: `Edited ${displayPath(workspace, abs)} (${replaceAll ? count : 1} replacement(s))` }],
        details: { path: abs },
      };
    },
  };
}
