import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, matchesGlob, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { displayPath, resolveToolPath } from "./paths.js";

const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_GREP_MATCHES = 200;
const MAX_FIND_RESULTS = 500;

async function* walkFiles(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function* single(file: string): AsyncGenerator<string> {
  yield file;
}

const GrepParams = Type.Object({
  pattern: Type.String({ description: "JavaScript regular expression" }),
  path: Type.Optional(Type.String({ description: "File or directory to search; defaults to the workspace" })),
  glob: Type.Optional(Type.String({ description: "Only search files matching this glob (relative to the search directory), for example **/*.md" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Ignore case" })),
});

export function createGrepTool(workspace: string): AgentTool<typeof GrepParams> {
  return {
    name: "grep",
    label: "Search contents",
    description: "Searches file contents with a regular expression and prints path:line:content.",
    parameters: GrepParams,
    async execute(_id, { pattern, path, glob, ignoreCase = false }) {
      const regex = new RegExp(pattern, ignoreCase ? "i" : "");
      const base = resolveToolPath(workspace, path ?? ".");
      const isFile = (await stat(base)).isFile();
      const root = isFile ? dirname(base) : base;
      const matches: string[] = [];
      let truncated = false;
      outer: for await (const file of isFile ? single(base) : walkFiles(base)) {
        if (glob && !matchesGlob(relative(root, file), glob)) continue;
        let buf: Buffer;
        try {
          if ((await stat(file)).size > MAX_FILE_BYTES) continue;
          buf = await readFile(file);
        } catch {
          continue;
        }
        if (buf.length > MAX_FILE_BYTES || buf.subarray(0, 8000).includes(0)) continue;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (!regex.test(line)) continue;
          if (matches.length >= MAX_GREP_MATCHES) {
            truncated = true;
            break outer;
          }
          matches.push(`${displayPath(workspace, file)}:${i + 1}:${line.slice(0, 300)}`);
        }
      }
      const text =
        matches.length === 0
          ? "No matches"
          : matches.join("\n") + (truncated ? `\n… (more than ${MAX_GREP_MATCHES} results; truncated)` : "");
      return { content: [{ type: "text", text }], details: { count: matches.length } };
    },
  };
}

const FindParams = Type.Object({
  pattern: Type.String({ description: "Glob pattern (relative to the search directory), for example **/*.md" }),
  path: Type.Optional(Type.String({ description: "Directory to search; defaults to the workspace" })),
});

export function createFindTool(workspace: string): AgentTool<typeof FindParams> {
  return {
    name: "find",
    label: "Find files",
    description: "Finds files matching a glob pattern and prints paths relative to the search directory.",
    parameters: FindParams,
    async execute(_id, { pattern, path }) {
      const base = resolveToolPath(workspace, path ?? ".");
      const found: string[] = [];
      for await (const file of walkFiles(base)) {
        const rel = relative(base, file);
        if (matchesGlob(rel, pattern)) found.push(rel);
      }
      found.sort();
      const shown = found.slice(0, MAX_FIND_RESULTS);
      const text =
        shown.length === 0
          ? "No matching files found"
          : shown.join("\n") + (found.length > shown.length ? `\n… (${found.length} in total; showing the first ${MAX_FIND_RESULTS})` : "");
      return { content: [{ type: "text", text }], details: { count: found.length } };
    },
  };
}
