import { join } from "node:path";
import type { WikiRepo } from "./git.js";
import { fingerprint, type FileFingerprint, type MarkerStore, type TouchedPath } from "./marker.js";

const ALLOWED_PREFIXES = ["wiki/", "raw/"];

/** Porcelain status lines are `"XY path"`; the path begins after the two status columns and one space. */
function statusPath(line: string): string {
  return line.slice(3);
}

function sameFingerprint(after: FileFingerprint | undefined, current: FileFingerprint): boolean {
  return after?.type === current.type && after?.hash === current.hash;
}

async function restoreTouched(repo: WikiRepo, touched: TouchedPath[], baseHead: string): Promise<void> {
  const tracked = touched.filter((entry) => entry.expectedBefore.type === "file").map((entry) => entry.path);
  const untracked = touched.filter((entry) => entry.expectedBefore.type === "absent").map((entry) => entry.path);
  await repo.checkoutPaths(baseHead, tracked);
  await repo.removeUntracked(untracked);
}

/**
 * Recovers the working tree after an interrupted batch. Changes outside `wiki/` and `raw/` are
 * never attributable to the wiki and abort the run; only a `writing` marker whose recorded
 * `after` fingerprints still match is restored to `baseHead`.
 */
export async function inspectAndCleanTree(repo: WikiRepo, marker: MarkerStore): Promise<void> {
  const lines = await repo.status();
  const outside = lines.map(statusPath).filter((path) => !ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)));
  if (outside.length > 0) throw new Error("changes outside wiki/ and raw/: " + outside.join(", "));
  if (lines.length === 0) return;
  const inFlight = await marker.read();
  if (inFlight?.phase !== "writing") throw new Error("wiki batch marker is missing or not in the writing phase");
  for (const touched of inFlight.touched) {
    const current = await fingerprint(join(repo.root, touched.path));
    if (!sameFingerprint(touched.after, current)) throw new Error(`wiki path changed since the batch recorded it: ${touched.path}`);
  }
  await restoreTouched(repo, inFlight.touched, inFlight.baseHead);
}

/** Rolls back the still-recorded batch and clears the marker; does nothing when there is no marker. */
export async function abortBatch(repo: WikiRepo, marker: MarkerStore): Promise<void> {
  const inFlight = await marker.read();
  if (!inFlight) return;
  // Only paths whose current content still matches the recorded `after` are attributable; an
  // externally edited or incomplete entry is kept so it is never silently overwritten or deleted.
  const attributable: TouchedPath[] = [];
  for (const touched of inFlight.touched) {
    const current = await fingerprint(join(repo.root, touched.path));
    if (touched.after && sameFingerprint(touched.after, current)) attributable.push(touched);
  }
  await restoreTouched(repo, attributable, inFlight.baseHead);
  await marker.remove();
}

export function ingestMessage(kind: "scheduled" | "bootstrap" | "on-demand", batchId: string, scanBase: string | null, count: number, now: Date): string {
  return `wiki: ingest ${now.toISOString()} (${count} notes)\n\nVex-Batch: ${batchId}\nVex-Kind: ${kind}\nVex-Scan-Base: ${scanBase ?? "none"}`;
}

export function ingestPrompt(kind: "scheduled" | "bootstrap" | "on-demand"): string {
  return `Run the ${kind} wiki ingest. Update the affected pages under wiki/ and _index.md. Write only inside wiki/ and raw/.`;
}
