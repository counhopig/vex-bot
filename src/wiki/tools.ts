import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { WikiRepo } from "./git.js";
import { assertUnchanged, expectedBeforeFor, fingerprint, type FileFingerprint, type InFlightMarker, type MarkerStore } from "./marker.js";
import { resolveInSubtree } from "./paths.js";
import type { Wiki } from "./service.js";

export interface WikiWriteContext {
  repo: WikiRepo;
  marker: MarkerStore;
  roots: { wiki: string; raw: string };
}

/** Resolves a vault path (`wiki/…` or `raw/…`) to its absolute location, rejecting everything else. */
async function resolveVaultPath(roots: { wiki: string; raw: string }, path: string): Promise<string> {
  if (path.startsWith("wiki/")) return resolveInSubtree(roots.wiki, path.slice("wiki/".length));
  if (path.startsWith("raw/")) return resolveInSubtree(roots.raw, path.slice("raw/".length));
  throw new Error(`wiki path must start with wiki/ or raw/: ${path}`);
}

/** The version of `path` at the batch's base revision; absent when the file did not exist there. */
async function baselineFrom(repo: WikiRepo, baseHead: string, path: string): Promise<FileFingerprint> {
  try {
    const content = await repo.show(baseHead, path);
    return { type: "file", hash: createHash("sha256").update(content).digest("hex") };
  } catch {
    return { type: "absent", hash: null };
  }
}

async function loadMarker(marker: MarkerStore): Promise<InFlightMarker> {
  const state = await marker.read();
  if (!state) throw new Error("no in-flight wiki marker");
  return state;
}

/**
 * Persists the intent, verifies nothing external changed the file, then writes and records the
 * resulting fingerprint. Any failure before the write leaves the file untouched.
 */
async function commitWrite(ctx: WikiWriteContext, path: string, abs: string, content: string): Promise<void> {
  const { marker } = ctx;
  const state = await loadMarker(marker);
  const baseline = await baselineFrom(ctx.repo, state.baseHead, path);
  const expected = expectedBeforeFor(state, path, baseline);
  await marker.recordIntent(path, expected);
  await assertUnchanged(abs, expected);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  await marker.recordAfter(path, await fingerprint(abs));
}

const WikiIngestParams = Type.Object({
  url: Type.Optional(Type.String({ description: "Source URL" })),
  title: Type.Optional(Type.String({ description: "Source title" })),
  text: Type.String({ description: "Source text to ingest" }),
});

const WikiBootstrapParams = Type.Object({
  action: Type.Union([Type.Literal("approve"), Type.Literal("reject")], { description: "Publish or discard the bootstrap preview" }),
});

const WikiRollbackParams = Type.Object({});

/** The interactive wiki tools: on-demand ingestion and bootstrap review, driven by a conversation. */
export function createWikiInteractiveTools(wiki: Wiki): AgentTool<any>[] {
  const fallbackSignal = (signal: AbortSignal | undefined): AbortSignal => signal ?? new AbortController().signal;

  const ingestTool: AgentTool<typeof WikiIngestParams> = {
    name: "wiki_ingest",
    label: "Ingest into wiki",
    description: "Ingests a source text into the wiki on demand. Refused until the bootstrap preview has been approved.",
    parameters: WikiIngestParams,
    async execute(_id, { url, title, text }, signal) {
      if (text === undefined || text === "") throw new Error("text must not be empty");
      const status = await wiki.status();
      if (status.bootstrap !== "done") throw new Error("the wiki bootstrap is awaiting approval");
      const result = await wiki.run({ kind: "on-demand", source: { url, title, text } }, fallbackSignal(signal));
      const summary = result === null ? "no changes" : `ingested ${result.pages.length} path(s)${result.pushed ? " and pushed" : " locally"}`;
      return { content: [{ type: "text", text: summary }], details: { summary } };
    },
  };

  const bootstrapTool: AgentTool<typeof WikiBootstrapParams> = {
    name: "wiki_bootstrap",
    label: "Review wiki bootstrap",
    description: "Approves (publishes) or rejects (discards) the pending wiki bootstrap preview.",
    parameters: WikiBootstrapParams,
    async execute(_id, { action }, signal) {
      const result = action === "approve"
        ? await wiki.approveBootstrap(fallbackSignal(signal))
        : await wiki.rejectBootstrap(fallbackSignal(signal));
      return { content: [{ type: "text", text: result.message }], details: { message: result.message } };
    },
  };

  const rollbackTool: AgentTool<typeof WikiRollbackParams> = {
    name: "wiki_rollback",
    label: "Roll back wiki batch",
    description: "Reverts the most recent committed wiki batch. Refused until the bootstrap preview has been approved.",
    parameters: WikiRollbackParams,
    async execute(_id, _params, signal) {
      const status = await wiki.status();
      if (status.bootstrap !== "done") throw new Error("the wiki bootstrap is awaiting approval");
      const result = await wiki.rollback(fallbackSignal(signal));
      return { content: [{ type: "text", text: result.message }], details: { message: result.message } };
    },
  };

  return [ingestTool, bootstrapTool, rollbackTool];
}

const WikiWriteParams = Type.Object({
  path: Type.String({ description: "Vault path starting with wiki/ or raw/, ending in .md" }),
  content: Type.String({ description: "Complete file content" }),
});

const WikiEditParams = Type.Object({
  path: Type.String({ description: "Vault path starting with wiki/ or raw/, ending in .md" }),
  oldText: Type.String({ description: "Text to replace; it must match the file content exactly" }),
  newText: Type.String({ description: "Replacement text" }),
  replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence; by default only a unique match is allowed" })),
});

export function createWikiWriteTools(ctx: WikiWriteContext): AgentTool<any>[] {
  const writeTool: AgentTool<typeof WikiWriteParams> = {
    name: "wiki_write",
    label: "Write wiki file",
    description: "Writes a complete vault file under wiki/ or raw/, after verifying it was not changed externally since this batch last touched it.",
    parameters: WikiWriteParams,
    async execute(_id, { path, content }) {
      const abs = await resolveVaultPath(ctx.roots, path);
      await commitWrite(ctx, path, abs, content);
      return { content: [{ type: "text", text: `Wrote ${path}` }], details: { path: abs } };
    },
  };

  const editTool: AgentTool<typeof WikiEditParams> = {
    name: "wiki_edit",
    label: "Edit wiki file",
    description: "Replaces oldText with newText in a vault file under wiki/ or raw/, after verifying it was not changed externally since this batch last touched it.",
    parameters: WikiEditParams,
    async execute(_id, { path, oldText, newText, replaceAll = false }) {
      if (oldText === "") throw new Error("oldText must not be empty");
      const abs = await resolveVaultPath(ctx.roots, path);
      const original = await readFile(abs, "utf8");
      const count = original.split(oldText).length - 1;
      if (count === 0) throw new Error(`oldText was not found in ${path}`);
      if (count > 1 && !replaceAll) {
        throw new Error(`oldText occurs ${count} times; add more context to make it unique, or set replaceAll`);
      }
      const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, () => newText);
      await commitWrite(ctx, path, abs, updated);
      return { content: [{ type: "text", text: `Edited ${path}` }], details: { path: abs } };
    },
  };

  return [writeTool, editTool];
}
