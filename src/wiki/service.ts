import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { VaultConfig } from "../config/schema.js";
import { abortBatch, ingestMessage, ingestPrompt, inspectAndCleanTree } from "./batch.js";
import { chunk, detectChanges, type Change } from "./changes.js";
import { parseTrailers, WikiRepo, type GitRunner } from "./git.js";
import { fingerprint, MarkerStore } from "./marker.js";
import { validateSubtreeRoots } from "./paths.js";
import { reconcile, type ReconcileResult } from "./reconcile.js";
import { emptyState, StateStore, type WikiState } from "./state.js";

export interface WikiRollbackResult {
  reverted: boolean;
  commit: string | null;
  message: string;
}

export interface WikiRunContext {
  repo: WikiRepo;
  marker: MarkerStore;
  roots: { wiki: string; raw: string };
}

export interface WikiOptions {
  home: string;
  vault: VaultConfig & { url: string };
  branch?: string;
  maxNotesPerRun: number;
  notifyEnabled: boolean;
  notify: (text: string) => Promise<void>;
  runAgent: (prompt: string, context: WikiRunContext, signal: AbortSignal) => Promise<string>;
  readSkill: () => Promise<string>;
  now?: () => number;
  run?: GitRunner;
  onWarning?: (m: string) => void;
}

/**
 * The wiki subsystem's shared runtime: one writable clone, a serial run lock, the
 * crash marker, durable state, and history reconciliation. All vault writes happen
 * inside `run` through the run-scoped tools built from its `WikiRunContext`.
 */
export class Wiki {
  private repo!: WikiRepo;
  private roots!: { wiki: string; raw: string };
  private marker!: MarkerStore;
  private stateStore!: StateStore;
  private reconciled: ReconcileResult | null = null;
  private cachedNextAttemptAt: number | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: WikiOptions) {}

  /** The writable working copy root, for the daemon to point `Vault` reads at. */
  get root(): string {
    return this.repo.root;
  }

  /** Synchronous backoff gate for the scheduler. */
  nextAttemptAt(): number | null {
    return this.cachedNextAttemptAt;
  }

  async init(): Promise<void> {
    const { home, vault, branch, run, onWarning } = this.opts;
    this.repo = new WikiRepo({ home, url: vault.url, branch, username: vault.username, token: vault.token, run, onWarning });
    const root = await this.repo.open();
    this.roots = await validateSubtreeRoots(root);
    this.marker = new MarkerStore(join(root, ".git"));
    this.stateStore = new StateStore(join(home, "state", "wiki.json"));
    const state = await this.stateStore.read();
    this.cachedNextAttemptAt = state?.nextAttemptAt ?? null;
    this.reconciled = await this.runReconcile(state);
  }

  async status(): Promise<{ bootstrap: "pending" | "awaiting-review" | "done"; nextAttemptAt: number | null; lastBatchId: string | null }> {
    const state = await this.stateStore.read();
    const reconciled = await this.runReconcile(state);
    this.reconciled = reconciled;
    this.cachedNextAttemptAt = state?.nextAttemptAt ?? null;
    // `lastBatchId` is a batch UUID, not a commit; resolve it before any ancestry probe.
    const lastBatchId = reconciled.lastBatchId ?? state?.lastBatchId ?? null;

    let bootstrap: "pending" | "awaiting-review" | "done" = "pending";
    if (lastBatchId !== null) {
      const commit = await this.findCommit("Vex-Batch", lastBatchId);
      const originHead = await this.repo.originHead();
      if (commit !== null && !(await this.repo.isAncestor(commit, originHead))) bootstrap = "awaiting-review";
      else if (reconciled.bootstrap === "done") bootstrap = "done";
    } else if (reconciled.bootstrap === "done") {
      bootstrap = "done";
    }

    return { bootstrap, nextAttemptAt: state?.nextAttemptAt ?? null, lastBatchId };
  }

  async close(): Promise<void> {
    this.reconciled = null;
  }

  async run(
    kind: { kind: "scheduled" | "bootstrap" | "on-demand"; source?: { title?: string; url?: string; text?: string } },
    signal: AbortSignal,
  ): Promise<{ commit: string | null; pages: string[]; pushed: boolean } | null> {
    return this.withLock(async () => {
      try {
      await this.repo.fetch();
      const state = await this.stateStore.read();
      const reconciled = await this.runReconcile(state);
      this.reconciled = reconciled;
      const skill = await this.opts.readSkill().catch(() => "");

      const advancesScan = kind.kind !== "on-demand";
      let baseHead = "";
      let batchId = "";

      // A rollback that was committed but not published must be settled before any new batch.
      if (reconciled.rollback || state?.rollback) await this.settleRollback(state, reconciled);
      // A batch whose commit already exists is never restored from files; drop the stale marker
      // so the tree check cannot mistake it for an interrupted writing phase.
      if (reconciled.markerResolution === "committed") await this.marker.remove();

      const previewCommit = reconciled.lastBatchId === null ? null : await this.findCommit("Vex-Batch", reconciled.lastBatchId);
      if (reconciled.bootstrap === "pending" && previewCommit !== null && !(await this.repo.isAncestor(previewCommit, await this.repo.originHead()))) {
        throw new Error("bootstrap preview awaiting review");
      }

      try {
        await inspectAndCleanTree(this.repo, this.marker);
        await this.repo.rebase();
        if (!(await this.repo.isAncestor(await this.repo.head(), await this.repo.originHead()))) await this.repo.push();
        baseHead = await this.repo.head();
      } catch (error) {
        await abortBatch(this.repo, this.marker);
        throw error;
      }

      // A compile run ingests every note added since the last scan, splitting them across as
      // many agent calls as `maxNotesPerRun` allows. On-demand runs skip detection entirely.
      const from = state?.lastScanCommit ?? null;
      if (kind.kind !== "on-demand") {
        const changes = await detectChanges(this.repo, from);
        if (changes.length === 0) {
          const current = (await this.stateStore.read()) ?? emptyState();
          await this.stateStore.write({ ...current, lastScanCommit: advancesScan ? baseHead : current.lastScanCommit, failureStreak: 0, nextAttemptAt: null });
          this.cachedNextAttemptAt = null;
          return null;
        }
        batchId = randomUUID();
        try {
          await this.marker.begin({
            batchId,
            kind: kind.kind,
            advancesScan,
            scanBase: advancesScan ? baseHead : null,
            baseHead,
            phase: "writing",
            commit: null,
            touched: [],
          });
          for (const part of chunk(changes, this.opts.maxNotesPerRun)) {
            await this.opts.runAgent([skill, this.chunkPrompt(part)].filter(Boolean).join("\n\n"), { repo: this.repo, marker: this.marker, roots: this.roots }, signal);
          }
        } catch (error) {
          await abortBatch(this.repo, this.marker);
          throw error;
        }
      } else {
        batchId = randomUUID();
        try {
          await this.marker.begin({
            batchId,
            kind: kind.kind,
            advancesScan,
            scanBase: null,
            baseHead,
            phase: "writing",
            commit: null,
            touched: [],
          });
          await this.opts.runAgent([skill, this.sourcePrompt(kind)].filter(Boolean).join("\n\n"), { repo: this.repo, marker: this.marker, roots: this.roots }, signal);
        } catch (error) {
          await abortBatch(this.repo, this.marker);
          throw error;
        }
      }

      const inFlight = await this.marker.read();
      const touched = inFlight?.touched ?? [];
      const scanBase = inFlight?.scanBase ?? null;

      if (touched.length === 0) {
        if ((await this.repo.head()) !== (await this.repo.originHead())) {
          await abortBatch(this.repo, this.marker);
          throw new Error("wiki run advanced HEAD without recording any paths");
        }
        const current = (await this.stateStore.read()) ?? emptyState();
        await this.stateStore.write({ ...current, lastScanCommit: advancesScan ? baseHead : current.lastScanCommit, failureStreak: 0, nextAttemptAt: null });
        this.cachedNextAttemptAt = null;
        await this.marker.remove();
        return null;
      }

      let sha = "";
      try {
        if ((await this.repo.head()) !== baseHead) throw new Error("wiki run changed HEAD before committing the batch");
        for (const entry of touched) {
          const current = await fingerprint(join(this.repo.root, entry.path));
          const expected = entry.after;
          if (!expected || current.type !== expected.type || current.hash !== expected.hash) {
            throw new Error(`wiki path changed since the batch recorded it: ${entry.path}`);
          }
        }
        sha = await this.repo.commit(
          touched.map((entry) => entry.path),
          ingestMessage(kind.kind, batchId, scanBase, touched.length, new Date()),
        );
      } catch (error) {
        await abortBatch(this.repo, this.marker);
        throw error;
      }
      await this.marker.setCommitted(sha);

      let pushed = false;
      try {
        if (kind.kind !== "bootstrap") {
          await this.pushWithRetry();
          pushed = true;
          const headAfterPush = await this.repo.head();
          if (headAfterPush !== sha) {
            sha = headAfterPush;
            await this.marker.setCommitted(sha);
          }
        }
        const current = (await this.stateStore.read()) ?? emptyState();
        await this.stateStore.write({
          ...current,
          lastBatchId: batchId,
          lastScanCommit: advancesScan && pushed ? scanBase : current.lastScanCommit,
          rollback: null,
          failureStreak: 0,
          nextAttemptAt: null,
          lastRunAt: Date.now(),
        });
        await this.marker.remove();
      } catch (error) {
        if (this.opts.notifyEnabled) await this.opts.notify(`wiki: batch ${batchId} committed but not finalized`);
        throw error;
      }

      if (this.opts.notifyEnabled) {
        await this.opts.notify(kind.kind === "bootstrap" ? "wiki: preview ready for review" : `wiki: ingested ${touched.length} paths`).catch(() => undefined);
      }
      this.cachedNextAttemptAt = null;
      return { commit: sha, pages: touched.map((entry) => entry.path), pushed };
      } catch (error) {
        await this.recordFailure();
        throw error;
      }
    });
  }

  /** Records a failed run and the exponential backoff that gates the next attempt. */
  private async recordFailure(): Promise<void> {
    const current = (await this.stateStore.read()) ?? emptyState();
    const failureStreak = current.failureStreak + 1;
    const backoff = Math.min(60 * 60_000, 5 * 60_000 * 2 ** (failureStreak - 1));
    const nextAttemptAt = Date.now() + backoff;
    await this.stateStore.write({ ...current, failureStreak, nextAttemptAt });
    this.cachedNextAttemptAt = nextAttemptAt;
  }

  /** Reverts the most recent committed compile batch exactly once, or completes a pending rollback. */
  async rollback(signal: AbortSignal): Promise<WikiRollbackResult> {
    signal.throwIfAborted();
    return this.withLock(async () => {
      await this.repo.fetch();
      const state = await this.stateStore.read();
      const reconciled = await this.runReconcile(state);

      if (reconciled.rollback || state?.rollback) {
        await this.settleRollback(state, reconciled);
        return { reverted: true, commit: await this.repo.head(), message: "completed a pending rollback" };
      }

      if ((await this.repo.status()).length > 0) return { reverted: false, commit: null, message: "working tree is not clean" };

      const batchId = reconciled.lastBatchId ?? state?.lastBatchId ?? null;
      if (!batchId) return { reverted: false, commit: null, message: "there is nothing to roll back" };

      const target = await this.findCommit("Vex-Batch", batchId);
      if (!target) {
        await this.clearBatchRef();
        return { reverted: false, commit: null, message: "the last batch no longer exists" };
      }

      if (!(await this.repo.isAncestor(target, await this.repo.originHead()))) {
        if ((await this.repo.head()) !== target) return { reverted: false, commit: null, message: "the unpublished batch is not the local tip; kept" };
        await this.repo.resetHard(`${target}^`);
        await this.clearBatchRef();
        return { reverted: true, commit: await this.repo.head(), message: "discarded the unpublished batch" };
      }

      const revertId = randomUUID();
      let revertSha: string;
      try {
        revertSha = await this.repo.revert(target, `wiki: rollback ${batchId}\n\nVex-Rollback: ${revertId}\nVex-Revert-Of: ${batchId}`);
      } catch (error) {
        await this.repo.resetHard(await this.repo.head());
        return { reverted: false, commit: null, message: `revert failed: ${(error as Error).message}` };
      }

      const current = (await this.stateStore.read()) ?? emptyState();
      await this.stateStore.write({ ...current, rollback: { targetBatchId: batchId, revertId } });
      try {
        await this.pushWithRetry();
      } catch {
        return { reverted: false, commit: revertSha, message: "revert committed locally but push failed; a later run will complete it" };
      }
      await this.clearBatchRef();
      return { reverted: true, commit: await this.repo.head(), message: "reverted the last batch" };
    });
  }

  /** Publishes an unpublished bootstrap preview and marks the bootstrap done. */
  async approveBootstrap(signal: AbortSignal): Promise<{ pushed: boolean; message: string }> {
    signal.throwIfAborted();
    return this.withLock(async () => {
      await this.repo.fetch();
      const state = await this.stateStore.read();
      const reconciled = await this.runReconcile(state);
      const batchId = reconciled.lastBatchId ?? state?.lastBatchId ?? null;
      const commit = batchId === null ? null : await this.findCommit("Vex-Batch", batchId);
      if (commit === null || reconciled.bootstrap !== "pending" || (await this.repo.isAncestor(commit, await this.repo.originHead()))) {
        return { pushed: false, message: "there is nothing to approve" };
      }
      try {
        await this.pushWithRetry();
      } catch (error) {
        return { pushed: false, message: `could not publish the preview: ${(error as Error).message}` };
      }
      const current = (await this.stateStore.read()) ?? emptyState();
      await this.stateStore.write({ ...current, bootstrap: "done", lastRunAt: Date.now() });
      return { pushed: true, message: "bootstrap preview published" };
    });
  }

  /** Discards an unpublished bootstrap preview locally, or marks it done when it was already published. */
  async rejectBootstrap(signal: AbortSignal): Promise<{ discarded: boolean; message: string }> {
    signal.throwIfAborted();
    return this.withLock(async () => {
      await this.repo.fetch();
      const state = await this.stateStore.read();
      const reconciled = await this.runReconcile(state);
      const batchId = reconciled.lastBatchId ?? state?.lastBatchId ?? null;
      const commit = batchId === null ? null : await this.findCommit("Vex-Batch", batchId);
      if (commit === null) return { discarded: false, message: "there is nothing to reject" };

      const current = (await this.stateStore.read()) ?? emptyState();
      if (await this.repo.isAncestor(commit, await this.repo.originHead())) {
        await this.stateStore.write({ ...current, bootstrap: "done" });
        return { discarded: false, message: "the preview was already published; bootstrap marked done" };
      }
      if ((await this.repo.head()) !== commit) return { discarded: false, message: "the unpublished preview is not the local tip; kept" };

      await this.repo.resetHard(`${commit}^`);
      await this.marker.remove();
      await this.stateStore.write({ ...current, lastBatchId: null, rollback: null, bootstrap: "pending" });
      return { discarded: true, message: "bootstrap preview discarded" };
    });
  }

  /** The one-shot prompt for an on-demand run, carrying the requesting source when present. */
  private sourcePrompt(kind: {
    kind: "scheduled" | "bootstrap" | "on-demand";
    source?: { title?: string; url?: string; text?: string };
  }): string {
    const lines = [ingestPrompt(kind.kind)];
    if (kind.source?.title) lines.push(`Source title: ${kind.source.title}`);
    if (kind.source?.url) lines.push(`Source URL: ${kind.source.url}`);
    if (kind.source?.text) lines.push(`Source text:\n${kind.source.text}`);
    return lines.join("\n");
  }

  /** The prompt for one chunk of detected changes: each path with its status and the write scope. */
  private chunkPrompt(changes: Change[]): string {
    const lines = changes.map((change) =>
      change.status === "D" && change.previous ? `D ${change.path}\n${change.previous}` : `${change.status} ${change.path}`,
    );
    return [
      "Apply these vault changes to the wiki.",
      ...lines,
      "Update the affected pages under wiki/ and _index.md. Write only inside wiki/ and raw/.",
    ].join("\n");
  }

  /** Finds the newest commit whose message carries `trailer: value`. */
  private async findCommit(trailer: string, value: string): Promise<string | null> {
    const parts = (await this.repo.log("HEAD")).split("\0");
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const sha = (parts[index] ?? "").trim();
      const body = parts[index + 1] ?? "";
      if (parseTrailers(body)[trailer]?.includes(value)) return sha;
    }
    return null;
  }

  /** Publishes a pending rollback, clearing the batch reference; throws when the push cannot complete. */
  private async settleRollback(state: WikiState | null, reconciled: ReconcileResult): Promise<void> {
    if (!reconciled.rollback && !state?.rollback) return;
    await this.pushWithRetry();
    await this.clearBatchRef();
  }

  private async clearBatchRef(): Promise<void> {
    const current = (await this.stateStore.read()) ?? emptyState();
    await this.stateStore.write({ ...current, lastBatchId: null, rollback: null });
  }

  /** Pushes the committed batch; on a rejected push it integrates the remote once and retries, accepting an already-published HEAD. */
  private async pushWithRetry(): Promise<void> {
    try {
      await this.repo.push();
      return;
    } catch {
      // Another writer advanced the remote; fetch, rebase and retry once.
    }
    await this.repo.fetch();
    await this.repo.rebase();
    try {
      await this.repo.push();
    } catch (error) {
      await this.repo.fetch();
      if (await this.repo.isAncestor(await this.repo.head(), await this.repo.originHead())) return;
      throw error;
    }
  }

  private async runReconcile(state: WikiState | null): Promise<ReconcileResult> {
    return reconcile({
      repo: this.repo,
      state,
      marker: await this.marker.read(),
      bootstrapRef: await this.repo.ref("refs/vex/wiki-bootstrap"),
    });
  }

  /** Serializes wiki runs: callers queue behind the previous one instead of interleaving repository work. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
