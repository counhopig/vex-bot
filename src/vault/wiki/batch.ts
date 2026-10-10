import { join } from "node:path";
import type { WikiRepo } from "./git.js";
import { fingerprint, type FileFingerprint, type MarkerStore, type TouchedPath } from "./marker.js";
import { resolveInSubtree, validateSubtreeRoot } from "./paths.js";

const ALLOWED_PREFIXES = ["wiki/", "raw/"];

function sameFingerprint(after: FileFingerprint | undefined, current: FileFingerprint): boolean {
  return after?.type === current.type && after?.hash === current.hash;
}

export async function assertSafeTouchedPath(repo: WikiRepo, path: string): Promise<void> {
  const prefix = ALLOWED_PREFIXES.find((candidate) => path.startsWith(candidate));
  if (!prefix) throw new Error(`wiki batch path is outside managed roots: ${path}`);
  const root = join(repo.root, prefix.slice(0, -1));
  const resolved = await resolveInSubtree(root, path.slice(prefix.length));
  if (resolved !== join(repo.root, path)) throw new Error(`wiki batch path contains a redirected component: ${path}`);
}

export async function assertBatchOwnership(repo: WikiRepo, touched: TouchedPath[]): Promise<void> {
  const entries = await repo.statusEntries();
  const dirtyPaths = new Set(entries.flatMap((entry) => entry.originalPath ? [entry.path, entry.originalPath] : [entry.path]));
  const owned = new Set(touched.map((entry) => entry.path));
  const unknown = [...dirtyPaths].filter((path) => !owned.has(path));
  if (unknown.length) throw new Error("dirty paths are not owned by the wiki batch: " + unknown.join(", "));
  for (const entry of touched) {
    await assertSafeTouchedPath(repo, entry.path);
    if (!entry.after) throw new Error(`incomplete write intent for ${entry.path}`);
    const current = await fingerprint(join(repo.root, entry.path));
    if (!sameFingerprint(entry.after, current)) throw new Error(`wiki path changed since the batch recorded it: ${entry.path}`);
  }
}

async function restoreTouched(repo: WikiRepo, touched: TouchedPath[], baseHead: string): Promise<void> {
  // Whether a path is tracked is a property of `baseHead`, not of the per-write `expectedBefore`:
  // a new file written twice records `expectedBefore: file`, and `git checkout <baseHead> --` on a
  // path absent from that tree fails with "pathspec did not match any file(s) known to git".
  const tracked: string[] = [];
  const untracked: string[] = [];
  const baselineFiles = await repo.filesAt(baseHead, touched.map((entry) => entry.path));
  for (const entry of touched) {
    const baseline = await repo.fingerprintAt(baseHead, entry.path);
    if (baseline.type !== "absent" && baseline.type !== "file") {
      throw new Error(`wiki cleanup refuses unsupported baseline type for ${entry.path}`);
    }
    if (baselineFiles.has(entry.path)) tracked.push(entry.path);
    else untracked.push(entry.path);
  }
  await validateSubtreeRoot(join(repo.root, "wiki"));
  await validateSubtreeRoot(join(repo.root, "raw"));
  await repo.checkoutPaths(baseHead, tracked);
  await repo.removeUntracked(untracked);
}

/**
 * Recovers the working tree after an interrupted batch. Changes outside `wiki/` and `raw/` are
 * never attributable to the wiki and abort the run; only a `writing` marker whose recorded
 * `after` fingerprints still match is restored to `baseHead`.
 */
export async function inspectAndCleanTree(repo: WikiRepo, marker: MarkerStore): Promise<void> {
  await validateSubtreeRoot(join(repo.root, "wiki"));
  await validateSubtreeRoot(join(repo.root, "raw"));
  const entries = await repo.statusEntries();
  const dirtyPaths = new Set(entries.flatMap((entry) => entry.originalPath ? [entry.path, entry.originalPath] : [entry.path]));
  const outside = [...dirtyPaths].filter((path) => !ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)));
  if (outside.length > 0) throw new Error("changes outside wiki/ and raw/: " + outside.join(", "));
  const inFlight = await marker.read();
  if (!inFlight) {
    if (entries.length > 0) throw new Error("wiki batch marker is missing or not in the writing phase");
    return;
  }
  if (inFlight.phase !== "writing") throw new Error("wiki batch marker is missing or not in the writing phase");
  const touched = new Map(inFlight.touched.map((entry) => [entry.path, entry]));
  const unknown = [...dirtyPaths].filter((path) => !touched.has(path));
  if (unknown.length) throw new Error("dirty paths are not owned by the wiki batch: " + unknown.join(", "));
  for (const touched of inFlight.touched) {
    await assertSafeTouchedPath(repo, touched.path);
    if (!touched.after) throw new Error(`incomplete write intent for ${touched.path}`);
    const current = await fingerprint(join(repo.root, touched.path));
    if (!sameFingerprint(touched.after, current)) throw new Error(`wiki path changed since the batch recorded it: ${touched.path}`);
  }
  const before = new Map(await Promise.all(inFlight.touched.map(async (entry) => [entry.path, await repo.fingerprintAt(inFlight.baseHead, entry.path)] as const)));
  const after = new Map(inFlight.touched.map((entry) => [entry.path, entry.after!]));
  await repo.assertIndexFingerprints(before, after);
  await restoreTouched(repo, inFlight.touched.filter((entry) => dirtyPaths.has(entry.path)), inFlight.baseHead);
  await marker.remove();
}

/** Rolls back the still-recorded batch and clears the marker; does nothing when there is no marker. */
export async function abortBatch(repo: WikiRepo, marker: MarkerStore): Promise<void> {
  const inFlight = await marker.read();
  if (!inFlight) return;
  if (inFlight.phase !== "writing") throw new Error("cannot abort a committed wiki batch");
  const entries = await repo.statusEntries();
  const dirtyPaths = new Set(entries.flatMap((entry) => entry.originalPath ? [entry.path, entry.originalPath] : [entry.path]));
  const unknown = [...dirtyPaths].filter((path) => !inFlight.touched.some((entry) => entry.path === path));
  if (unknown.length) throw new Error("dirty paths are not owned by the wiki batch: " + unknown.join(", "));
  const attributable: TouchedPath[] = [];
  for (const touched of inFlight.touched) {
    await assertSafeTouchedPath(repo, touched.path);
    if (!touched.after) throw new Error(`incomplete write intent for ${touched.path}`);
    const current = await fingerprint(join(repo.root, touched.path));
    if (!sameFingerprint(touched.after, current)) throw new Error(`wiki path changed since the batch recorded it: ${touched.path}`);
    if (dirtyPaths.has(touched.path)) attributable.push(touched);
  }
  const before = new Map(await Promise.all(inFlight.touched.map(async (entry) => [entry.path, await repo.fingerprintAt(inFlight.baseHead, entry.path)] as const)));
  const after = new Map(inFlight.touched.map((entry) => [entry.path, entry.after!]));
  await repo.assertIndexFingerprints(before, after);
  await restoreTouched(repo, attributable, inFlight.baseHead);
  await marker.remove();
}

export function ingestMessage(kind: "scheduled" | "bootstrap" | "on-demand", batchId: string, scanBase: string | null, count: number, now: Date): string {
  return `wiki: ingest ${now.toISOString()} (${count} notes)\n\nVex-Batch: ${batchId}\nVex-Kind: ${kind}\nVex-Scan-Base: ${scanBase ?? "none"}`;
}

export function ingestPrompt(kind: "scheduled" | "bootstrap" | "on-demand"): string {
  return `Run the ${kind} wiki ingest. Update the affected pages under wiki/ and _index.md. Write only inside wiki/ and raw/.`;
}
