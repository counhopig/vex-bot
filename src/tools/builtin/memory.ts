/**
 * Built-in tools — Long-term memory (store / search / list / delete).
 *
 * Ported from _archive/src/tools/builtin/memory.ts. Key changes:
 *   - Uses Tool type from ../types.js (not AgentTool from pi-agent-core).
 *   - MemoryManager imported type-only from the real module (see below).
 *   - When manager is undefined, every tool returns { status: "disabled" }.
 *   - 5-param execute (match ToolDefinition, last 3 prefixed with _).
 */

import { Type, type Static } from "@sinclair/typebox";
import type { Tool } from "../types.js";
import type { MemoryManager } from "../../memory/MemoryManager.js";
import type { MemoryEntry } from "../../memory/types.js";
import {
  jsonResult,
  errorResult,
  readStringParam,
  readNumberParam,
  readStringArrayParam,
} from "../common.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MemoryToolsOptions {
  /** Per-user MemoryManager instance. When undefined, tools return disabled. */
  manager?: MemoryManager;
}

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------

export function createMemorySearchTool(manager?: MemoryManager): Tool {
  const parameters = Type.Object({
    query: Type.String({ description: "Search query" }),
    type: Type.Optional(
      Type.String({
        description: "Filter by type: conversation, fact, note, code",
        enum: ["conversation", "fact", "note", "code"],
      }),
    ),
    tags: Type.Optional(
      Type.Array(Type.String(), { description: "Filter by tags" }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max results (default: 5)",
        minimum: 1,
        maximum: 20,
      }),
    ),
    min_score: Type.Optional(
      Type.Number({
        description: "Min relevance score 0-1",
        minimum: 0,
        maximum: 1,
      }),
    ),
  });

  return {
    name: "memory_search",
    label: "Memory Search",
    description: "Search stored memories by semantic similarity.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const activeManager = manager;
      if (!activeManager) {
        return jsonResult({
          status: "disabled",
          message: "Memory system not enabled",
          results: [],
        });
      }

      const params = args as Static<typeof parameters>;
      const query = params.query;
      const type = params.type;
      const tags = params.tags;
      const limit = params.limit ?? 5;
      const minScore = params.min_score ?? 0.1;

      try {
        let results = await activeManager.recall(query, limit * 2);
        if (type) {
          results = results.filter(
            (r) => r.metadata.type === type,
          );
        }
        if (tags?.length) {
          results = results.filter((r) =>
            tags.some((tag) => r.metadata.tags?.includes(tag)),
          );
        }
        results = results
          .filter((r) => (r.score ?? 0) >= minScore)
          .slice(0, limit);

        return jsonResult({
          status: "success",
          query,
          count: results.length,
          results: results.map((r) => ({
            id: r.id,
            content: r.content,
            type: r.metadata.type,
            tags: r.metadata.tags,
            score: r.score
              ? Math.round(r.score * 100) / 100
              : undefined,
            date: new Date(r.metadata.timestamp).toISOString(),
          })),
        });
      } catch (error) {
        return errorResult(
          `Memory search failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// memory_store
// ---------------------------------------------------------------------------

export function createMemoryStoreTool(manager?: MemoryManager): Tool {
  const parameters = Type.Object({
    content: Type.String({
      description: "Content to store",
      minLength: 1,
    }),
    type: Type.Optional(
      Type.String({
        description: "Type: fact, note, code, conversation",
        enum: ["fact", "note", "code", "conversation"],
      }),
    ),
    tags: Type.Optional(
      Type.Array(Type.String(), { description: "Tags for categorization" }),
    ),
    source: Type.Optional(
      Type.String({ description: "Source of the information" }),
    ),
  });

  return {
    name: "memory_store",
    label: "Memory Store",
    description: "Store important information for future reference.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const activeManager = manager;
      if (!activeManager) {
        return jsonResult({
          status: "disabled",
          message: "Memory system not enabled",
        });
      }

      const params = args as Static<typeof parameters>;
      const content = params.content;
      const type = (params.type ?? "note") as
        | "fact"
        | "note"
        | "code"
        | "conversation";
      const tags = params.tags;
      const source = params.source;

      try {
        const id = await activeManager.remember(content, {
          type,
          tags: tags ?? undefined,
          source: source ?? undefined,
        });
        return jsonResult({
          status: "success",
          id,
          type,
          tags,
          message: "Memory stored",
        });
      } catch (error) {
        return errorResult(
          `Memory store failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// memory_list
// ---------------------------------------------------------------------------

export function createMemoryListTool(manager?: MemoryManager): Tool {
  const parameters = Type.Object({
    type: Type.Optional(
      Type.String({
        description: "Filter by type",
        enum: ["conversation", "fact", "note", "code"],
      }),
    ),
    tags: Type.Optional(
      Type.Array(Type.String(), { description: "Filter by tags" }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max entries (default: 20)",
        minimum: 1,
        maximum: 100,
      }),
    ),
  });

  return {
    name: "memory_list",
    label: "Memory List",
    description: "List stored memories with optional filtering.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const activeManager = manager;
      if (!activeManager) {
        return jsonResult({
          status: "disabled",
          message: "Memory system not enabled",
          entries: [],
        });
      }

      const params = args as Static<typeof parameters>;
      const type = params.type;
      const tags = params.tags;
      const limit = params.limit ?? 20;

      try {
        let entries = await activeManager.list({
          type: type ?? undefined,
          tags: tags ?? undefined,
        });
        entries.sort(
          (a, b) => b.metadata.timestamp - a.metadata.timestamp,
        );
        entries = entries.slice(0, limit);

        return jsonResult({
          status: "success",
          count: entries.length,
          entries: entries.map((e) => ({
            id: e.id,
            content:
              e.content.length > 200
                ? e.content.slice(0, 200) + "..."
                : e.content,
            type: e.metadata.type,
            tags: e.metadata.tags,
            date: new Date(e.metadata.timestamp).toISOString(),
          })),
        });
      } catch (error) {
        return errorResult(
          `Memory list failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// memory_delete
// ---------------------------------------------------------------------------

export function createMemoryDeleteTool(manager?: MemoryManager): Tool {
  const parameters = Type.Object({
    id: Type.String({ description: "Memory entry ID to delete" }),
  });

  return {
    name: "memory_delete",
    label: "Memory Delete",
    description: "Delete a specific memory entry by ID.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const activeManager = manager;
      if (!activeManager) {
        return jsonResult({
          status: "disabled",
          message: "Memory system not enabled",
        });
      }

      const params = args as Static<typeof parameters>;
      const id = params.id;

      try {
        const deleted = await activeManager.forget(id);
        if (deleted) {
          return jsonResult({
            status: "success",
            id,
            message: "Memory deleted",
          });
        }
        return jsonResult({
          status: "not_found",
          id,
          message: "Memory entry not found",
        });
      } catch (error) {
        return errorResult(
          `Memory delete failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Batch factory
// ---------------------------------------------------------------------------

export function createMemoryTools(options?: MemoryToolsOptions): Tool[] {
  return [
    createMemorySearchTool(options?.manager),
    createMemoryStoreTool(options?.manager),
    createMemoryListTool(options?.manager),
    createMemoryDeleteTool(options?.manager),
  ];
}
