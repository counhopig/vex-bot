import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WikiRepo } from "./git.js";
import { assertUnchanged, expectedBeforeFor, fingerprint, type FileFingerprint, type InFlightMarker, type MarkerStore } from "./marker.js";
import { resolveInSubtree, validateSubtreeRoot } from "./paths.js";

export interface WikiWriteContext {
  repo: WikiRepo;
  marker: MarkerStore;
  roots: { wiki: string; raw: string };
  writeFile?: (path: string, content: string) => Promise<void>;
}

/** Resolves a vault path (`wiki/…` or `raw/…`) to its absolute location, rejecting everything else. */
export async function resolveVaultPath(roots: { wiki: string; raw: string }, path: string): Promise<string> {
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

/**
 * Writes one batch-owned `wiki/` or `raw/` file under the in-flight marker's ownership checks.
 * Pass `resolved` when the caller already read the file there, so a path that moved since is refused.
 */
export async function writeWikiFile(ctx: WikiWriteContext, path: string, content: string, resolved?: string): Promise<string> {
  const abs = resolved ?? await resolveVaultPath(ctx.roots, path);
  await commitWrite(ctx, path, abs, content);
  return abs;
}
