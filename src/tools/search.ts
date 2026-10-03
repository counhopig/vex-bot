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
  pattern: Type.String({ description: "JavaScript 正则表达式" }),
  path: Type.Optional(Type.String({ description: "要搜索的文件或目录，默认工作区" })),
  glob: Type.Optional(Type.String({ description: "只搜索匹配该 glob 的文件（相对搜索目录），例如 **/*.md" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "忽略大小写" })),
});

export function createGrepTool(workspace: string): AgentTool<typeof GrepParams> {
  return {
    name: "grep",
    label: "搜索内容",
    description: "按正则表达式搜索文件内容，输出「路径:行号:内容」。",
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
          ? "没有匹配"
          : matches.join("\n") + (truncated ? `\n…（结果超过 ${MAX_GREP_MATCHES} 条，已截断）` : "");
      return { content: [{ type: "text", text }], details: { count: matches.length } };
    },
  };
}

const FindParams = Type.Object({
  pattern: Type.String({ description: "glob 模式（相对搜索目录），例如 **/*.md" }),
  path: Type.Optional(Type.String({ description: "搜索目录，默认工作区" })),
});

export function createFindTool(workspace: string): AgentTool<typeof FindParams> {
  return {
    name: "find",
    label: "查找文件",
    description: "按 glob 模式查找文件，输出相对搜索目录的路径。",
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
          ? "没有找到匹配的文件"
          : shown.join("\n") + (found.length > shown.length ? `\n…（共 ${found.length} 个，只列出前 ${MAX_FIND_RESULTS} 个）` : "");
      return { content: [{ type: "text", text }], details: { count: found.length } };
    },
  };
}
