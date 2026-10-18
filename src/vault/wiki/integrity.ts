import { parseTrailers, WikiIntegrityError, type WikiRepo } from "./git.js";

export interface WikiIntegrityObservation {
  fetchUrls: string[];
  pushUrls: string[];
  branch: string;
  head: string;
  remoteTip: string;
  localOnly: string[];
  status: Array<{ index: string; worktree: string; path: string; originalPath?: string }>;
}

const values = (trailers: Record<string, string[]>, name: string): string[] => {
  for (const key of Object.keys(trailers)) if (key.toLowerCase() === name.toLowerCase()) return trailers[key] ?? [];
  return [];
};
const generated = (path: string): boolean => path.startsWith("wiki/") || path.startsWith("raw/");

function records(log: string): Array<{ sha: string; body: string }> {
  const fields = log.split("\0");
  const found: Array<{ sha: string; body: string }> = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const sha = (fields[i] ?? "").trim();
    if (/^[0-9a-f]{40,64}$/i.test(sha)) found.push({ sha, body: fields[i + 1] ?? "" });
  }
  return found;
}

/** Captures repository identity, refreshed publication boundary and machine-readable tree state. */
export async function observeWiki(repo: WikiRepo): Promise<WikiIntegrityObservation> {
  await repo.assertIdentity();
  const [urls, branch, head, remoteTip] = await Promise.all([
    repo.originUrls(), repo.activeBranch(), repo.head(), repo.originHead(),
  ]);
  if (!(await repo.isAncestor(head, remoteTip)) && !(await repo.isAncestor(remoteTip, head)) && !(await repo.mergeBase(head, remoteTip))) {
    throw new WikiIntegrityError("wiki local and remote histories have no common base; preserving local repository");
  }
  const localOnly = await repo.isAncestor(head, remoteTip) ? [] : records(await repo.log(`${remoteTip}..${head}`)).map((record) => record.sha);
  return { fetchUrls: urls.fetch, pushUrls: urls.push, branch, head, remoteTip, localOnly, status: await repo.statusEntries() };
}

/** Rejects unpublished commits unless trailers and their actual changed paths prove Wiki ownership. */
export async function assertRecognizedLocalHistory(repo: WikiRepo, observation?: WikiIntegrityObservation): Promise<void> {
  const observed = observation ?? await observeWiki(repo);
  const localRecords = records(await repo.log(`${observed.remoteTip}..${observed.head}`));
  const allRecords = records(await repo.log("HEAD"));
  const batches = new Map<string, string[]>();
  const rollbacks = new Map<string, string[]>();
  for (const record of allRecords) {
    const trailers = parseTrailers(record.body);
    const ids = values(trailers, "Vex-Batch");
    for (const id of ids) if (id) batches.set(id, [...(batches.get(id) ?? []), record.sha]);
    const rollbackIds = values(trailers, "Vex-Rollback");
    for (const id of rollbackIds) if (id) rollbacks.set(id, [...(rollbacks.get(id) ?? []), record.sha]);
  }
  for (const [id, commits] of batches) if (commits.length > 1) throw new WikiIntegrityError(`duplicate or ambiguous Vex-Batch identity ${id}`);
  for (const [id, commits] of rollbacks) if (commits.length > 1) throw new WikiIntegrityError(`duplicate or ambiguous Vex-Rollback identity ${id}`);
  if (observed.localOnly.length === 0) return;
  const seen = new Set<string>();
  for (const record of localRecords) {
    const trailers = parseTrailers(record.body);
    const batch = values(trailers, "Vex-Batch");
    const rollback = values(trailers, "Vex-Rollback");
    const revertOf = values(trailers, "Vex-Revert-Of");
    const paths = await repo.changedPaths(record.sha);
    if (!paths.length || paths.some((path) => !generated(path))) throw new WikiIntegrityError(`unrecognized local commit ${record.sha}: changes outside generated wiki/raw paths`);
    if (batch.length === 1 && batch[0] && rollback.length === 0 && revertOf.length === 0) {
      const id = batch[0];
      if (seen.has(id) || (batches.get(id)?.length ?? 0) !== 1) throw new WikiIntegrityError(`duplicate or ambiguous Vex-Batch identity ${id}`);
      const kinds = values(trailers, "Vex-Kind");
      const scanBases = values(trailers, "Vex-Scan-Base");
      const kind = kinds[0];
      const scanBase = scanBases[0];
      if (kinds.length !== 1 || !["scheduled", "bootstrap", "on-demand"].includes(kind ?? "") || scanBases.length !== 1 || !scanBase) {
        throw new WikiIntegrityError(`invalid Vex-Batch metadata on ${record.sha}`);
      }
      if (kind === "on-demand" ? scanBase !== "none" : scanBase === "none") throw new WikiIntegrityError(`invalid Vex-Scan-Base for ${kind} batch ${id}`);
      if (scanBase !== "none") {
        if (!/^[0-9a-f]{40,64}$/i.test(scanBase)) throw new WikiIntegrityError(`invalid Vex-Scan-Base on ${record.sha}`);
        try {
          await repo.isAncestor(scanBase, record.sha);
        } catch {
          throw new WikiIntegrityError(`unresolvable Vex-Scan-Base on ${record.sha}`);
        }
        if (!(await repo.isAncestor(scanBase, record.sha))) throw new WikiIntegrityError(`Vex-Scan-Base is outside batch ancestry on ${record.sha}`);
      }
      seen.add(id);
      continue;
    }
    if (batch.length === 0 && rollback.length === 1 && rollback[0] && revertOf.length === 1 && revertOf[0]) {
      const targets = batches.get(revertOf[0]) ?? [];
      if (targets.length !== 1 || rollback.some((id) => !id)) throw new WikiIntegrityError(`invalid rollback relationship for ${record.sha}`);
      const revertIds = values(trailers, "Vex-Rollback");
      if (revertIds.length !== 1 || seen.has(`rollback:${revertIds[0]}`) || !(await repo.isAncestor(targets[0]!, record.sha))) throw new WikiIntegrityError(`invalid rollback identity or ordering ${revertIds[0] ?? ""}`);
      seen.add(`rollback:${revertIds[0]}`);
      continue;
    }
    throw new WikiIntegrityError(`unrecognized local commit ${record.sha}: missing unique Vex provenance trailers`);
  }
}

