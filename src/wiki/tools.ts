import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { WikiRepo } from "./git.js";
import { assertUnchanged, expectedBeforeFor, fingerprint, type FileFingerprint, type InFlightMarker, type MarkerStore } from "./marker.js";
import { resolveInSubtree, validateSubtreeRoot } from "./paths.js";
import { wikiRawPath, type Wiki, type WikiRunResult } from "./service.js";
import type { OriginalSource } from "../links/source.js";

export interface WikiWriteContext {
  repo: WikiRepo;
  marker: MarkerStore;
  roots: { wiki: string; raw: string };
  writeFile?: (path: string, content: string) => Promise<void>;
}

/** Resolves a vault path (`wiki/…` or `raw/…`) to its absolute location, rejecting everything else. */
async function resolveVaultPath(roots: { wiki: string; raw: string }, path: string): Promise<string> {
  if (path.startsWith("wiki/")) return resolveInSubtree(roots.wiki, path.slice("wiki/".length));
  if (path.startsWith("raw/")) return resolveInSubtree(roots.raw, path.slice("raw/".length));
  throw new Error(`wiki path must start with wiki/ or raw/: ${path}`);
}

/** The version of `path` at the batch's base revision; absent when the file did not exist there. */
async function baselineFrom(repo: WikiRepo, baseHead: string, path: string): Promise<FileFingerprint> {
  return repo.fingerprintAt(baseHead, path);
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
  validateSubtreeRoot(path.startsWith("wiki/") ? ctx.roots.wiki : ctx.roots.raw);
  const baseline = await baselineFrom(ctx.repo, state.baseHead, path);
  const expected = expectedBeforeFor(state, path, baseline);
  await marker.recordIntent(path, expected);
  validateSubtreeRoot(path.startsWith("wiki/") ? ctx.roots.wiki : ctx.roots.raw);
  await assertUnchanged(abs, expected);
  const fresh = await resolveVaultPath(ctx.roots, path);
  if (fresh !== abs) throw new Error(`wiki path changed while preparing write: ${path}`);
  await mkdir(dirname(abs), { recursive: true });
  if (ctx.writeFile) await ctx.writeFile(abs, content);
  else await writeFile(abs, content, "utf8");
  const intendedAfter: FileFingerprint = { type: "file", hash: createHash("sha256").update(content, "utf8").digest("hex") };
  const observedAfter = await fingerprint(abs);
  if (observedAfter.type !== intendedAfter.type || observedAfter.hash !== intendedAfter.hash) {
    throw new Error(`wiki path changed while completing write: ${path}`);
  }
  await marker.recordAfter(path, intendedAfter);
}

const WikiIngestParams = Type.Object({
  url: Type.Optional(Type.String({ description: "Source URL" })),
  title: Type.Optional(Type.String({ description: "Source title" })),
  text: Type.Optional(Type.String({ description: "Manual source text to ingest when URL is omitted" })),
});

const WikiBootstrapParams = Type.Object({
  action: Type.Union([Type.Literal("approve"), Type.Literal("reject")], { description: "Publish or discard the bootstrap preview" }),
});

const WikiRollbackParams = Type.Object({});

/** The interactive wiki tools: on-demand ingestion and bootstrap review, driven by a conversation. */
export interface WikiReceipt {
  version: 1;
  status: "completed" | "failed-read" | "failed-run" | "bootstrap-pending";
  requestedUrl: string | null;
  canonicalUrl: string | null;
  sourceAvailable: boolean;
  metadataOnly: boolean;
  truncated: boolean;
  compiledPages: string[];
  rawPath: string | null;
  batchId: string | null;
  commit: string | null;
  publication: "not-needed" | "preview" | "published" | "pending";
  excerpt: string;
  error?: string;
}

export function createWikiInteractiveTools(wiki: Wiki, options: { sourceResolver?: (url: string, signal: AbortSignal) => Promise<OriginalSource> } = {}): AgentTool<any>[] {
  const fallbackSignal = (signal: AbortSignal | undefined): AbortSignal => signal ?? new AbortController().signal;

  const ingestTool: AgentTool<typeof WikiIngestParams> = {
    name: "wiki_ingest",
    label: "Ingest into wiki",
    description: "Ingest a URL by retrieving and archiving its original source, or ingest nonempty manual text without a URL.",
    parameters: WikiIngestParams,
    async execute(_id, { url, text }, signal) {
      if ((!url && (typeof text !== "string" || !text.trim())) || (url !== undefined && url.trim() === "")) throw new Error("provide a URL or nonempty manual text");
      const status = await wiki.status();
      const requestedUrl = url ?? null;
      if (status.bootstrap !== "done") {
        const receipt: WikiReceipt = { version: 1, status: "bootstrap-pending", requestedUrl, canonicalUrl: null, sourceAvailable: false, metadataOnly: false, truncated: false, rawPath: null, batchId: null, commit: null, publication: "not-needed", compiledPages: [], excerpt: "", error: status.bootstrap };
        return receiptResult(receipt);
      }
      const operationSignal = fallbackSignal(signal);
      let source: OriginalSource | undefined;
      if (url) {
        if (!options.sourceResolver) return receiptResult(failedReceipt(url, "Original source retrieval is unavailable."));
        try {
          operationSignal.throwIfAborted();
          source = await options.sourceResolver(url, operationSignal);
          operationSignal.throwIfAborted();
        } catch (error) {
          operationSignal.throwIfAborted();
          return receiptResult(failedReceipt(url, error instanceof Error ? error.message : String(error)));
        }
        if (source.truncated) return receiptResult({ ...failedReceipt(url, "The retrieved source is truncated and cannot be archived completely."), canonicalUrl: source.canonicalUrl, sourceAvailable: Boolean(source.text.trim()), truncated: true, excerpt: source.text.slice(0, 1000) });
        if (!source.text.trim()) {
          return receiptResult({ ...sourceReceipt(url, source, undefined), rawPath: null, metadataOnly: true });
        }
      }
      const input = url
        ? { kind: "on-demand" as const, source: { url, title: source?.title, canonicalUrl: source?.canonicalUrl, text: source?.text ?? "", truncated: source?.truncated, textKind: source?.textKind, metadataOnly: !source?.text.trim() } }
        : { kind: "on-demand" as const, source: { text: text! } };
      let result: WikiRunResult;
      try { result = await wiki.run(input, operationSignal); }
      catch (error) {
        operationSignal.throwIfAborted();
        return receiptResult({ ...sourceReceipt(url ?? null, source, text), status: "failed-run", rawPath: null, error: error instanceof Error ? error.message : String(error) });
      }
      const receipt: WikiReceipt = {
        ...sourceReceipt(requestedUrl, source, text), status: "completed",
        rawPath: source?.text.trim() && url ? wikiRawPath(url) : null,
        batchId: result.batchId, commit: result.commit, publication: result.publication, compiledPages: result.pages,
      };
      return receiptResult(receipt);
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

function failedReceipt(url: string | null, error: string): WikiReceipt {
  return { version: 1, status: "failed-read", requestedUrl: url, canonicalUrl: null, sourceAvailable: false, metadataOnly: false, truncated: false, rawPath: null, batchId: null, commit: null, publication: "not-needed", compiledPages: [], excerpt: "", error };
}

function sourceReceipt(requestedUrl: string | null, source: OriginalSource | undefined, manualText: string | undefined): WikiReceipt {
  const sourceAvailable = source ? Boolean(source.text.trim()) : Boolean(manualText?.trim());
  return {
    version: 1, status: "completed", requestedUrl, canonicalUrl: source?.canonicalUrl ?? null,
    sourceAvailable, metadataOnly: source !== undefined && !sourceAvailable, truncated: source?.truncated ?? false,
    rawPath: null, batchId: null, commit: null, publication: "not-needed", compiledPages: [],
    excerpt: (source?.text ?? manualText ?? "").slice(0, 1000),
  };
}

function receiptResult(receipt: WikiReceipt) {
  const serialized = JSON.stringify(receipt);
  return { content: [{ type: "text" as const, text: serialized }], details: { receipt } };
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
  let pending: Promise<unknown> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const next = pending.then(action);
    pending = next.catch(() => {});
    return next;
  };
  const writeTool: AgentTool<typeof WikiWriteParams> = {
    name: "wiki_write",
    label: "Write wiki file",
    description: "Writes a complete vault file under wiki/ or raw/, after verifying it was not changed externally since this batch last touched it.",
    parameters: WikiWriteParams,
    executionMode: "sequential",
    execute(_id, { path, content }) {
      return serialize(async () => {
        const abs = await resolveVaultPath(ctx.roots, path);
        await commitWrite(ctx, path, abs, content);
        return { content: [{ type: "text", text: `Wrote ${path}` }], details: { path: abs } };
      });
    },
  };

  const editTool: AgentTool<typeof WikiEditParams> = {
    name: "wiki_edit",
    label: "Edit wiki file",
    description: "Replaces oldText with newText in a vault file under wiki/ or raw/, after verifying it was not changed externally since this batch last touched it.",
    parameters: WikiEditParams,
    executionMode: "sequential",
    execute(_id, { path, oldText, newText, replaceAll = false }) {
      return serialize(async () => {
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
      });
    },
  };

  return [writeTool, editTool];
}
