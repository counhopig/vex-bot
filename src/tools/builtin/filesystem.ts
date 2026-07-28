/**
 * Built-in tools — File system (read_file, write_file, edit_file,
 * list_directory, glob, grep).
 *
 * Path traversal protection preserved from _archive/src/tools/builtin/filesystem.ts:
 *   - resolveUserPath — resolves relative paths against the sandbox base
 *   - isPathAllowed — validates against allowedPaths prefix
 *   - resolveRealPath — follows symlinks THEN re-validates (symlink escape guard)
 *   - isRealPathAllowed — realpath-aware version of isPathAllowed
 *
 * Every filesystem tool calls isRealPathAllowed before any I/O. The
 * realpath() call + re-validation is the defense against symlink-based
 * path traversal out of the allowed sandbox.
 */

import { Type, type Static } from "@sinclair/typebox";
import { readFile, writeFile, stat, readdir, realpath } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, relative, sep, dirname, basename } from "path";
import { glob } from "glob";
import type { Tool } from "../types.js";
import {
  jsonResult,
  textResult,
  readStringParam,
  readNumberParam,
  readBooleanParam,
} from "../common.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FilesystemToolsOptions {
  allowedPaths?: string[];
  maxFileSize?: number;
  maxLines?: number;
}

const DEFAULT_OPTIONS: Required<FilesystemToolsOptions> = {
  allowedPaths: [process.cwd()],
  maxFileSize: 10 * 1024 * 1024,
  maxLines: 2000,
};

// ---------------------------------------------------------------------------
// Path security helpers
// ---------------------------------------------------------------------------

/** Resolve a (possibly relative) model-supplied path against the sandbox
 *  base (first allowed path) rather than process.cwd(), so relative paths
 *  land inside a scoped per-user working directory. Absolute paths are
 *  unaffected. */
export function resolveUserPath(
  allowedPaths: string[],
  filePath: string,
): string {
  return resolve(allowedPaths[0] ?? process.cwd(), filePath);
}

function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  const resolved = resolve(filePath);
  return allowedPaths.some((allowed) => {
    const resolvedAllowed = resolve(allowed);
    return (
      resolved === resolvedAllowed ||
      resolved.startsWith(resolvedAllowed + sep)
    );
  });
}

/**
 * Resolve the real path (follow symlinks) to prevent path traversal.
 * For non-existent files (e.g., write_file creating a new file), resolve
 * the parent directory's real path and rejoin the basename.
 */
async function resolveRealPath(filePath: string): Promise<string> {
  const abs = resolve(filePath);
  try {
    return await realpath(abs);
  } catch {
    // File doesn't exist (yet) — validate the parent.
    const parent = dirname(abs);
    try {
      const realParent = await realpath(parent);
      return join(realParent, basename(abs));
    } catch {
      return abs;
    }
  }
}

/**
 * Same as isPathAllowed, but follows symlinks before validating to
 * prevent escaping allowed paths via symlinks within the workspace.
 */
export async function isRealPathAllowed(
  filePath: string,
  allowedPaths: string[],
): Promise<boolean> {
  const real = await resolveRealPath(filePath);
  return isPathAllowed(real, allowedPaths);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export function createReadFileTool(options?: FilesystemToolsOptions): Tool {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const parameters = Type.Object({
    path: Type.String({
      description: "Absolute or relative path to the file",
    }),
    offset: Type.Optional(
      Type.Number({
        description: "Line number to start reading from (1-based)",
        minimum: 1,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Maximum number of lines to read",
        minimum: 1,
      }),
    ),
  });

  return {
    name: "read_file",
    label: "Read File",
    description:
      "Read the contents of a file. Supports text files with optional line range.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const filePath = params.path;
      const offset = params.offset ?? 1;
      const limit = params.limit ?? opts.maxLines;
      const resolved = resolveUserPath(opts.allowedPaths, filePath);

      if (!(await isRealPathAllowed(resolved, opts.allowedPaths))) {
        return jsonResult(
          { status: "error", error: `Access denied: ${filePath}` },
          true,
        );
      }
      if (!existsSync(resolved)) {
        return jsonResult(
          { status: "error", error: `File not found: ${filePath}` },
          true,
        );
      }

      try {
        const stats = await stat(resolved);
        if (stats.isDirectory()) {
          return jsonResult(
            { status: "error", error: `Path is a directory: ${filePath}` },
            true,
          );
        }
        if (stats.size > opts.maxFileSize) {
          return jsonResult(
            { status: "error", error: `File too large: ${stats.size}` },
            true,
          );
        }

        const content = await readFile(resolved, "utf-8");
        const lines = content.split("\n");
        const startIdx = Math.max(0, offset - 1);
        const endIdx = Math.min(lines.length, startIdx + limit);
        const numbered = lines
          .slice(startIdx, endIdx)
          .map((line, i) => `${startIdx + i + 1}→${line}`)
          .join("\n");

        return textResult(numbered, {
          path: resolved,
          totalLines: lines.length,
          startLine: startIdx + 1,
          endLine: endIdx,
        });
      } catch (error) {
        return jsonResult(
          {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export function createWriteFileTool(options?: FilesystemToolsOptions): Tool {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const parameters = Type.Object({
    path: Type.String({
      description: "Absolute or relative path to the file",
    }),
    content: Type.String({ description: "Content to write to the file" }),
  });

  return {
    name: "write_file",
    label: "Write File",
    description:
      "Write content to a file. Creates the file if it doesn't exist.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const filePath = params.path;
      const content = params.content;
      const resolved = resolveUserPath(opts.allowedPaths, filePath);

      if (!(await isRealPathAllowed(resolved, opts.allowedPaths))) {
        return jsonResult(
          { status: "error", error: `Access denied: ${filePath}` },
          true,
        );
      }

      try {
        await writeFile(resolved, content, "utf-8");
        const stats = await stat(resolved);
        return jsonResult({
          status: "success",
          path: resolved,
          size: stats.size,
          lines: content.split("\n").length,
        });
      } catch (error) {
        return jsonResult(
          {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

export function createEditFileTool(options?: FilesystemToolsOptions): Tool {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const parameters = Type.Object({
    path: Type.String({
      description: "Absolute or relative path to the file",
    }),
    old_string: Type.String({
      description: "The exact string to find and replace",
    }),
    new_string: Type.String({
      description: "The string to replace it with",
    }),
    replace_all: Type.Optional(
      Type.Boolean({
        description: "Replace all occurrences (default: false)",
      }),
    ),
  });

  return {
    name: "edit_file",
    label: "Edit File",
    description: "Edit a file by replacing a specific string with another.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const filePath = params.path;
      const oldString = params.old_string;
      const newString = params.new_string;
      const replaceAll = params.replace_all ?? false;
      const resolved = resolveUserPath(opts.allowedPaths, filePath);

      if (!(await isRealPathAllowed(resolved, opts.allowedPaths))) {
        return jsonResult(
          { status: "error", error: `Access denied: ${filePath}` },
          true,
        );
      }
      if (!existsSync(resolved)) {
        return jsonResult(
          { status: "error", error: `File not found: ${filePath}` },
          true,
        );
      }

      try {
        const content = await readFile(resolved, "utf-8");
        const occurrences = content.split(oldString).length - 1;
        if (occurrences === 0) {
          return jsonResult(
            { status: "error", error: "String not found" },
            true,
          );
        }
        if (!replaceAll && occurrences > 1) {
          return jsonResult(
            {
              status: "error",
              error: `String appears ${occurrences} times. Use replace_all=true`,
            },
            true,
          );
        }
        const newContent = replaceAll
          ? content.split(oldString).join(newString)
          : content.replace(oldString, newString);
        await writeFile(resolved, newContent, "utf-8");
        return jsonResult({
          status: "success",
          path: resolved,
          replacements: replaceAll ? occurrences : 1,
        });
      } catch (error) {
        return jsonResult(
          {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

export function createListDirectoryTool(
  options?: FilesystemToolsOptions,
): Tool {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const parameters = Type.Object({
    path: Type.String({ description: "Path to the directory" }),
    recursive: Type.Optional(
      Type.Boolean({ description: "List recursively (default: false)" }),
    ),
    max_depth: Type.Optional(
      Type.Number({
        description: "Maximum depth for recursive listing (default: 3)",
        minimum: 1,
        maximum: 10,
      }),
    ),
  });

  return {
    name: "list_directory",
    label: "List Directory",
    description: "List the contents of a directory with file details.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const dirPath = params.path;
      const recursive = params.recursive ?? false;
      const maxDepth = params.max_depth ?? 3;
      const resolved = resolveUserPath(opts.allowedPaths, dirPath);

      if (!(await isRealPathAllowed(resolved, opts.allowedPaths))) {
        return jsonResult(
          { status: "error", error: `Access denied: ${dirPath}` },
          true,
        );
      }
      if (!existsSync(resolved)) {
        return jsonResult(
          { status: "error", error: `Directory not found: ${dirPath}` },
          true,
        );
      }

      try {
        const stats = await stat(resolved);
        if (!stats.isDirectory()) {
          return jsonResult(
            { status: "error", error: `Not a directory: ${dirPath}` },
            true,
          );
        }

        const entries: string[] = [];
        async function listDir(
          dir: string,
          depth: number,
          prefix: string,
        ): Promise<void> {
          if (depth > maxDepth) return;
          const items = await readdir(dir, { withFileTypes: true });
          items.sort((a, b) =>
            a.isDirectory() && !b.isDirectory()
              ? -1
              : !a.isDirectory() && b.isDirectory()
                ? 1
                : a.name.localeCompare(b.name),
          );
          for (const item of items) {
            const itemPath = join(dir, item.name);
            if (item.isDirectory()) {
              entries.push(`${prefix}${item.name}/`);
              if (recursive) await listDir(itemPath, depth + 1, prefix + "  ");
            } else {
              try {
                const s = await stat(itemPath);
                entries.push(
                  `${prefix}${item.name} (${formatSize(s.size)})`,
                );
              } catch {
                entries.push(`${prefix}${item.name}`);
              }
            }
          }
        }
        await listDir(resolved, 1, "");

        return textResult(entries.join("\n"), {
          path: resolved,
          totalEntries: entries.length,
          recursive,
        });
      } catch (error) {
        return jsonResult(
          {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

export function createGlobTool(options?: FilesystemToolsOptions): Tool {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const parameters = Type.Object({
    pattern: Type.String({ description: "Glob pattern to match files" }),
    path: Type.Optional(
      Type.String({
        description: "Base directory to search in (default: cwd)",
      }),
    ),
    max_results: Type.Optional(
      Type.Number({
        description: "Maximum number of results (default: 100)",
        minimum: 1,
        maximum: 1000,
      }),
    ),
  });

  return {
    name: "glob",
    label: "Glob Search",
    description: "Find files matching a glob pattern.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const pattern = params.pattern;
      const basePath = params.path ?? process.cwd();
      const maxResults = params.max_results ?? 100;
      const resolved = resolveUserPath(opts.allowedPaths, basePath);

      if (!(await isRealPathAllowed(resolved, opts.allowedPaths))) {
        return jsonResult(
          { status: "error", error: `Access denied: ${basePath}` },
          true,
        );
      }

      try {
        const matches = await glob(pattern, {
          cwd: resolved,
          nodir: false,
          ignore: ["**/node_modules/**", "**/.git/**"],
          maxDepth: 20,
        });
        const results = matches
          .slice(0, maxResults)
          .map((m: string) => join(resolved, m));

        return jsonResult({
          status: "success",
          pattern,
          basePath: resolved,
          matches: results,
          total: matches.length,
          truncated: matches.length > maxResults,
        });
      } catch (error) {
        return jsonResult(
          {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export function createGrepTool(options?: FilesystemToolsOptions): Tool {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const parameters = Type.Object({
    pattern: Type.String({
      description: "Regular expression pattern to search for",
    }),
    path: Type.Optional(
      Type.String({
        description: "File or directory to search in",
      }),
    ),
    glob_pattern: Type.Optional(
      Type.String({ description: "Glob pattern to filter files" }),
    ),
    context: Type.Optional(
      Type.Number({
        description: "Context lines before and after",
        minimum: 0,
        maximum: 10,
      }),
    ),
    max_results: Type.Optional(
      Type.Number({
        description: "Maximum number of matches",
        minimum: 1,
        maximum: 500,
      }),
    ),
    case_insensitive: Type.Optional(
      Type.Boolean({ description: "Case insensitive search" }),
    ),
  });

  return {
    name: "grep",
    label: "Grep Search",
    description: "Search for a pattern in files.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const pattern = params.pattern;
      const searchPath = params.path ?? process.cwd();
      const globPattern = params.glob_pattern ?? "**/*";
      const context = params.context ?? 0;
      const maxResults = params.max_results ?? 50;
      const caseInsensitive = params.case_insensitive ?? false;
      const resolved = resolveUserPath(opts.allowedPaths, searchPath);

      if (!(await isRealPathAllowed(resolved, opts.allowedPaths))) {
        return jsonResult(
          { status: "error", error: `Access denied: ${searchPath}` },
          true,
        );
      }

      try {
        const regex = new RegExp(pattern, caseInsensitive ? "gi" : "g");
        let files: string[];
        const pathStats = await stat(resolved);
        if (pathStats.isFile()) {
          files = [resolved];
        } else {
          const matches = await glob(globPattern, {
            cwd: resolved,
            nodir: true,
            ignore: ["**/node_modules/**", "**/.git/**"],
          });
          files = matches.map((m: string) => join(resolved, m));
        }

        const results: Array<{ file: string; line: number; content: string }> =
          [];
        for (const file of files) {
          if (results.length >= maxResults) break;
          try {
            const fileStats = await stat(file);
            if (fileStats.size > opts.maxFileSize) continue;
            const content = await readFile(file, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= maxResults) break;
              if (regex.test(lines[i]!)) {
                regex.lastIndex = 0;
                results.push({
                  file: relative(resolved, file),
                  line: i + 1,
                  content: lines[i]!.trim(),
                });
              }
            }
          } catch {
            // Skip files we can't read.
          }
        }

        return textResult(
          results
            .map((r) => `${r.file}:${r.line}: ${r.content}`)
            .join("\n---\n") || "No matches found",
          { pattern, totalMatches: results.length },
        );
      } catch (error) {
        return jsonResult(
          {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFilesystemTools(
  options?: FilesystemToolsOptions,
): Tool[] {
  return [
    createReadFileTool(options),
    createWriteFileTool(options),
    createEditFileTool(options),
    createListDirectoryTool(options),
    createGlobTool(options),
    createGrepTool(options),
  ];
}
