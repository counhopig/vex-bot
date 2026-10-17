import { readdir } from "node:fs/promises";
import { join, matchesGlob, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Worker } from "node:worker_threads";
import { resolveToolPath } from "./paths.js";

const SKIP_DIRS = new Set([".git", "node_modules"]);
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
    async execute(_id, { pattern, path, glob, ignoreCase = false }, signal) {
      signal?.throwIfAborted();
      const worker = new Worker(`(${grepWorker.toString()})()`, {
        eval: true,
        execArgv: [],
        workerData: { base: resolveToolPath(workspace, path ?? "."), workspace, pattern, glob, ignoreCase },
      });
      try {
        return await new Promise<{ content: { type: "text"; text: string }[]; details: { count: number } }>((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error("Search exceeded its 5 second execution limit")), 5000);
          const onAbort = () => finish(signal?.reason ?? new Error("Search cancelled"));
          const finish = (error?: unknown, result?: { text: string; count: number }) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else if (result) resolve({ content: [{ type: "text", text: result.text }], details: { count: result.count } });
          };
          worker.once("message", (result: { text: string; count: number }) => finish(undefined, result));
          worker.once("error", (error) => finish(error));
          worker.once("exit", (code) => { if (code !== 0) finish(new Error(`Search worker exited (${code})`)); });
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      } finally { await worker.terminate(); }
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

// Self-contained so the same worker runs from compiled JS and source test runners.
async function grepWorker(): Promise<void> {
  const { parentPort, workerData } = require("node:worker_threads") as typeof import("node:worker_threads");
  const { readdir, open, stat } = require("node:fs/promises") as typeof import("node:fs/promises");
  const { dirname, join, matchesGlob, relative, isAbsolute, sep } = require("node:path") as typeof import("node:path");
  const { base, workspace, pattern, glob, ignoreCase } = workerData as { base: string; workspace: string; pattern: string; glob?: string; ignoreCase: boolean };
  const regex = new RegExp(pattern, ignoreCase ? "i" : "");
  async function* walk(root: string): AsyncGenerator<string> {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(root, entry.name);
      if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") yield* walk(full);
      else if (entry.isFile()) yield full;
    }
  }
  const isFile = (await stat(base)).isFile();
  const root = isFile ? dirname(base) : base;
  const matches: string[] = [];
  let truncated = false;
  outer: for await (const file of isFile ? [base] : walk(base)) {
    if (glob && !matchesGlob(relative(root, file), glob)) continue;
    let buf: Buffer;
    try {
      const handle = await open(file, "r");
      try {
        const size = (await handle.stat()).size;
        if (size > 1_000_000) continue;
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, 0);
        buf = buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
    } catch { continue; }
    if (buf.length > 1_000_000 || buf.subarray(0, 8000).includes(0)) continue;
    const rel = relative(workspace, file);
    const display = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? file : rel || ".";
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!regex.test(line)) continue;
      if (matches.length >= 200) { truncated = true; break outer; }
      matches.push(`${display}:${i + 1}:${line.slice(0, 300)}`);
    }
  }
  parentPort!.postMessage({ text: matches.length === 0 ? "No matches" : matches.join("\n") + (truncated ? "\n… (more than 200 results; truncated)" : ""), count: matches.length });
}
