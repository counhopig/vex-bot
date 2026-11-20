import { parseTrailers, trailerValues, type WikiRepo } from "./git.js";
import type { InFlightMarker } from "./marker.js";

export interface CompileBatch { sha: string; id: string; kind: "scheduled" | "bootstrap" | "on-demand"; scanBase: string | null; published: boolean; preview: boolean }
export interface RollbackCommit { sha: string; id: string; revertOf: string; published: boolean }
export interface WikiRollback { targetBatchId: string; revertId: string }
export interface ReconcileInput { repo: WikiRepo; marker: InFlightMarker | null; bootstrapRef: string | null }
export interface ReconcileResult {
  lastBatchId: string | null;
  /** True when `lastBatchId` names a batch the remote already has; false only for a local-only one. */
  lastBatchPublished: boolean;
  bootstrap: "pending" | "done";
  rollback: WikiRollback | null;
  lastScanCommit: string | null;
  /** True when history carries the in-flight marker's batch: the batch is committed and the marker is stale. */
  staleMarker: boolean;
  alerts: string[];
  /** True only when the newest compile batch is an unpublished bootstrap preview awaiting review. */
  preview: boolean;
  /** The newest `Vex-Wiki-Reset` in history; batches, cursors and bootstrap evidence before it are ignored. */
  reset: { id: string; sha: string } | null;
}

const PREVIEW_SUBJECT = "wiki: bootstrap preview";
const SCAN_NONE = "none";
export const RESET_TRAILER = "Vex-Wiki-Reset";

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

function trailer(trailers: Record<string, string[]>, name: string): string | undefined {
  return trailerValues(trailers, name)[0];
}

function parseKind(value: string | undefined): CompileBatch["kind"] {
  return value === "bootstrap" || value === "on-demand" ? value : "scheduled";
}

/**
 * A scan base is only usable when git can resolve it as a commit. `isAncestor`
 * rethrows unknown-object failures (exit 128), so probing the value against itself
 * separates a real commit from a stale or corrupt SHA without leaking the error.
 */
async function resolvesCommit(repo: WikiRepo, sha: string): Promise<boolean> {
  try {
    await repo.isAncestor(sha, sha);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuilds the wiki's durable facts from committed history alone. Read-only by contract: it parses
 * `git log` and ancestry only, never writes, pushes, or mutates the tree. Whoever calls it performs
 * any push the result calls for.
 */
export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const { repo, marker } = input;
  let bootstrapRef = input.bootstrapRef;
  const origin = await repo.originHead();

  const batches: CompileBatch[] = [];
  const rollbacks: RollbackCommit[] = [];
  const alerts: string[] = [];
  let staleMarker = false;

  const localHead = await repo.head();
  const historyRef = await repo.isAncestor(localHead, origin) ? origin : "HEAD";
  // Every commit in the scanned history is published unless it is local-only.
  const unpublished = new Set(historyRef === origin ? [] : await repo.commitsBetween(origin, "HEAD"));
  const isPublished = (sha: string): boolean => !unpublished.has(sha);
  let reset: ReconcileResult["reset"] = null;
  for (const record of parseLog(await repo.log(historyRef))) {
    const trailers = parseTrailers(record.body);
    // A rebuild starts a new epoch: everything older than its reset commit no longer describes the wiki.
    const resetId = trailer(trailers, RESET_TRAILER);
    if (resetId !== undefined) {
      reset = { id: resetId, sha: record.sha };
      break;
    }
    const batchId = trailer(trailers, "Vex-Batch");
    const rollbackId = trailer(trailers, "Vex-Rollback");
    const revertOf = trailer(trailers, "Vex-Revert-Of");
    if (marker !== null && batchId === marker.batchId) staleMarker = true;
    if (batchId !== undefined) {
      const kind = parseKind(trailer(trailers, "Vex-Kind"));
      const scanBase = trailer(trailers, "Vex-Scan-Base");
      const batchPublished = isPublished(record.sha);
      const subject = record.body.split("\n")[0] ?? "";
      batches.push({
        sha: record.sha,
        id: batchId,
        kind,
        scanBase: scanBase === undefined || scanBase === SCAN_NONE ? null : scanBase,
        published: batchPublished,
        preview: subject.startsWith(PREVIEW_SUBJECT) || (kind === "bootstrap" && !batchPublished),
      });
    } else if (rollbackId !== undefined || revertOf !== undefined) {
      const rollbackIds = trailerValues(trailers, "vex-rollback");
      const revertTargets = trailerValues(trailers, "vex-revert-of");
      if (rollbackIds.length !== 1 || !rollbackIds[0] || revertTargets.length !== 1 || !revertTargets[0]) {
        alerts.push(`wiki history has an invalid rollback relationship on ${record.sha}`);
      } else {
        rollbacks.push({ sha: record.sha, id: rollbackIds[0], revertOf: revertTargets[0], published: isPublished(record.sha) });
      }
    }
  }

  if (reset) {
    // The bootstrap ref counts only when it was written in this epoch.
    if (bootstrapRef !== null && !(await repo.isAncestor(reset.sha, bootstrapRef).catch(() => false))) bootstrapRef = null;
  }

  const batchCounts = new Map<string, number>();
  for (const batch of batches) batchCounts.set(batch.id, (batchCounts.get(batch.id) ?? 0) + 1);
  for (const [id, count] of batchCounts) {
    if (count > 1) {
      alerts.push(`wiki history has duplicate Vex-Batch identity ${id}`);
      for (let index = batches.length - 1; index >= 0; index -= 1) if (batches[index]?.id === id) batches.splice(index, 1);
    }
  }
  const rollbackCounts = new Map<string, number>();
  for (const rollback of rollbacks) rollbackCounts.set(rollback.id, (rollbackCounts.get(rollback.id) ?? 0) + 1);
  for (const [id, count] of rollbackCounts) {
    if (count > 1) {
      alerts.push(`wiki history has duplicate Vex-Rollback identity ${id}`);
      for (let index = rollbacks.length - 1; index >= 0; index -= 1) if (rollbacks[index]?.id === id) rollbacks.splice(index, 1);
    }
  }

  for (const candidate of rollbacks) {
    const targets = batches.filter((batch) => batch.id === candidate.revertOf);
    if (targets.length !== 1 || !(await repo.isAncestor(targets[0]!.sha, candidate.sha))) {
      alerts.push(`wiki history has an invalid rollback relationship for batch ${candidate.revertOf}`);
    }
  }

  // Git log order is newest first, so the first compile batch is B_new.
  const newest = batches[0];
  const rollbackFor = async (targetId: string): Promise<RollbackCommit | undefined> => {
    const targets = batches.filter((candidate) => candidate.id === targetId);
    const matches = rollbacks.filter((candidate) => candidate.revertOf === targetId);
    if (matches.length === 0) return undefined;
    if (targets.length !== 1 || matches.length !== 1 || !(await repo.isAncestor(targets[0]!.sha, matches[0]!.sha))) {
      alerts.push(`wiki history has an invalid rollback relationship for batch ${targetId}`);
      return undefined;
    }
    return matches[0];
  };

  let lastBatchId: string | null = null;
  let lastBatchPublished = true;
  let rollback: WikiRollback | null = null;
  let previewPending = false;

  if (newest) {
    const reference = await rollbackFor(newest.id);
    if (reference) {
      // A revert that is already published means the rollback completed; only an unpublished one needs settling.
      lastBatchId = null;
      rollback = reference.published ? null : { targetBatchId: newest.id, revertId: reference.id };
    } else if (newest.preview && !newest.published) {
      previewPending = true;
      lastBatchId = newest.id;
      lastBatchPublished = newest.published;
    } else {
      lastBatchId = newest.id;
      lastBatchPublished = newest.published;
    }
  }

  // Bootstrap evidence is git-only: a published bootstrap batch or the bootstrap ref, both after the newest reset.
  let bootstrap: ReconcileResult["bootstrap"] = "pending";
  if (!previewPending) {
    const publishedBootstrap = batches.some((batch) => batch.kind === "bootstrap" && batch.published);
    bootstrap = publishedBootstrap || bootstrapRef !== null ? "done" : "pending";
  }

  // The scan cursor is the newest published advancing batch's scan base, by ancestor ordering.
  const candidates = [...new Set(batches.filter((batch) => batch.published && batch.scanBase !== null
    && (batch.kind === "scheduled" || batch.kind === "bootstrap")).map((batch) => batch.scanBase!))];
  let lastScanCommit: string | null = null;
  if (candidates.length === 1) {
    // Alone, the candidate is the cursor only when git can resolve it as a commit.
    if (await resolvesCommit(repo, candidates[0]!)) lastScanCommit = candidates[0]!;
  } else if (candidates.length > 1) {
    // `independent` resolves the newest in one git call; unresolvable candidates are dropped so
    // they can neither win nor make the ancestry check fail.
    let ordered = candidates;
    try {
      const tips = await repo.independent(ordered);
      const winner = tips.length === 1 && ordered.includes(tips[0]!) ? tips[0]! : null;
      lastScanCommit = winner;
    } catch {
      const resolvable: string[] = [];
      for (const sha of ordered) if (await resolvesCommit(repo, sha)) resolvable.push(sha);
      ordered = resolvable;
      if (ordered.length === 1) {
        lastScanCommit = ordered[0]!;
      } else if (ordered.length > 1) {
        const tips = await repo.independent(ordered);
        lastScanCommit = tips.length === 1 && ordered.includes(tips[0]!) ? tips[0]! : null;
      }
    }
    if (lastScanCommit === null && candidates.length > 1) alerts.push(`wiki scan cursor candidates are incomparable: ${candidates.join(", ")}`);
  }

  return { lastBatchId, lastBatchPublished, bootstrap, rollback, lastScanCommit, staleMarker, alerts, preview: previewPending, reset };
}
