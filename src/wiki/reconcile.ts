import { parseTrailers, type WikiRepo } from "./git.js";
import type { InFlightMarker } from "./marker.js";
import type { WikiRollback, WikiState } from "./state.js";

export interface CompileBatch { sha: string; id: string; kind: "scheduled" | "bootstrap" | "on-demand"; scanBase: string | null; published: boolean; preview: boolean }
export interface RollbackCommit { sha: string; id: string; revertOf: string; published: boolean }
export interface ReconcileInput { repo: WikiRepo; state: WikiState | null; marker: InFlightMarker | null; bootstrapRef: string | null }
export interface ReconcileResult {
  lastBatchId: string | null;
  bootstrap: "pending" | "done";
  rollback: WikiRollback | null;
  lastScanCommit: string | null;
  markerResolution: "none" | "committed" | "writing";
  alerts: string[];
}

const PREVIEW_SUBJECT = "wiki: bootstrap preview";
const SCAN_NONE = "none";

interface CommitRecord { sha: string; body: string }

/** One `%H%x00%B%x00` pair per commit, newest first; git separates records with a newline after the trailing NUL. */
function parseLog(output: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  const fields = output.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const sha = (fields[index] ?? "").trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    records.push({ sha, body: fields[index + 1] ?? "" });
  }
  return records;
}

/** parseTrailers preserves the first spelling of each key, so lookups are case-insensitive. */
function trailer(trailers: Record<string, string[]>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(trailers)) {
    if (key.toLowerCase() === lower) return trailers[key]?.[0];
  }
  return undefined;
}

function parseKind(value: string | undefined): CompileBatch["kind"] {
  return value === "bootstrap" || value === "on-demand" ? value : "scheduled";
}

/** The candidate that is a descendant of every other; `null` when the candidates are incomparable. */
async function newestCandidate(repo: WikiRepo, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    let wins = true;
    for (const other of candidates) {
      if (other === candidate) continue;
      if (!(await repo.isAncestor(other, candidate))) {
        wins = false;
        break;
      }
    }
    if (wins) return candidate;
  }
  return null;
}

/**
 * Rebuilds durable wiki state from committed history. Read-only by contract: it
 * parses `git log` and ancestry only, never writes, pushes, or mutates the tree.
 * The service's settle step performs any push the result calls for.
 */
export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const { repo, state, marker, bootstrapRef } = input;
  const origin = await repo.originHead();

  const publishedCache = new Map<string, boolean>();
  const isPublished = async (sha: string): Promise<boolean> => {
    const cached = publishedCache.get(sha);
    if (cached !== undefined) return cached;
    const value = await repo.isAncestor(sha, origin);
    publishedCache.set(sha, value);
    return value;
  };

  const batches: CompileBatch[] = [];
  const rollbacks: RollbackCommit[] = [];
  let markerResolution: ReconcileResult["markerResolution"] = marker === null ? "none" : "writing";

  for (const record of parseLog(await repo.log("HEAD"))) {
    const trailers = parseTrailers(record.body);
    const batchId = trailer(trailers, "Vex-Batch");
    const rollbackId = trailer(trailers, "Vex-Rollback");
    const revertOf = trailer(trailers, "Vex-Revert-Of");
    if (marker !== null && batchId === marker.batchId) markerResolution = "committed";
    if (batchId !== undefined) {
      const kind = parseKind(trailer(trailers, "Vex-Kind"));
      const scanBase = trailer(trailers, "Vex-Scan-Base");
      const batchPublished = await isPublished(record.sha);
      const subject = record.body.split("\n")[0] ?? "";
      batches.push({
        sha: record.sha,
        id: batchId,
        kind,
        scanBase: scanBase === undefined || scanBase === SCAN_NONE ? null : scanBase,
        published: batchPublished,
        preview: subject.startsWith(PREVIEW_SUBJECT) || (kind === "bootstrap" && !batchPublished),
      });
    } else if (rollbackId !== undefined && revertOf !== undefined) {
      rollbacks.push({ sha: record.sha, id: rollbackId, revertOf, published: await isPublished(record.sha) });
    }
  }

  // Git log order is newest first, so the first compile batch is B_new.
  const newest = batches[0];
  const rollbackFor = (targetId: string): RollbackCommit | undefined => rollbacks.find((candidate) => candidate.revertOf === targetId);

  let lastBatchId: string | null = null;
  let bootstrap: ReconcileResult["bootstrap"] = "pending";
  let rollback: WikiRollback | null = null;
  let previewPending = false;
  let rule3Rollback = false;

  if (newest) {
    const reference = rollbackFor(newest.id);
    if (reference) {
      // A revert that is already published means the rollback completed; only an unpublished one needs settling.
      rule3Rollback = true;
      lastBatchId = null;
      rollback = reference.published ? null : { targetBatchId: newest.id, revertId: reference.id };
    } else if (newest.preview && !newest.published) {
      previewPending = true;
      lastBatchId = newest.id;
    } else {
      lastBatchId = newest.id;
      if (newest.kind === "bootstrap" && newest.published) bootstrap = "done";
    }
  }

  // Rule 4: any durable completion evidence keeps bootstrap done; an unpublished preview overrides it.
  if (!previewPending) {
    const publishedBootstrap = batches.some((batch) => batch.kind === "bootstrap" && batch.published);
    bootstrap = publishedBootstrap || bootstrapRef !== null || state?.bootstrap === "done" ? "done" : "pending";
  }

  // Rule 5: a revert committed just before the state write is still recoverable from its trailers.
  if (!rule3Rollback) {
    for (const target of [lastBatchId, state?.rollback?.targetBatchId ?? null]) {
      if (target === null) continue;
      const reference = rollbackFor(target);
      if (reference) {
        rollback = reference.published ? null : { targetBatchId: target, revertId: reference.id };
        break;
      }
    }
  }

  // Rule 6: newest scan base by ancestor ordering, among the valid state value and published advancing batches.
  const candidates = new Set<string>();
  if (state?.lastScanCommit !== null && state?.lastScanCommit !== undefined) candidates.add(state.lastScanCommit);
  for (const batch of batches) {
    if (!batch.published || batch.scanBase === null) continue;
    if (batch.kind === "scheduled" || batch.kind === "bootstrap") candidates.add(batch.scanBase);
  }

  const ordered = [...candidates];
  const alerts: string[] = [];
  let lastScanCommit: string | null = null;
  if (ordered.length === 1) {
    lastScanCommit = ordered[0] ?? null;
  } else if (ordered.length > 1) {
    const winner = await newestCandidate(repo, ordered);
    if (winner !== null) {
      lastScanCommit = winner;
    } else {
      lastScanCommit = state?.lastScanCommit ?? null;
      alerts.push(`wiki scan cursor candidates are incomparable: ${ordered.join(", ")}`);
    }
  }

  return { lastBatchId, bootstrap, rollback, lastScanCommit, markerResolution, alerts };
}
