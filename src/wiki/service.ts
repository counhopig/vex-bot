import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { VaultConfig } from "../config/schema.js";
import { abortBatch, ingestMessage, ingestPrompt, inspectAndCleanTree } from "./batch.js";
import { WikiRepo, type GitRunner } from "./git.js";
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
 * The wiki subsystem's shared runtime. This slice installs the repository,
 * subtree roots, crash marker, durable state, and the reconciled history
 * snapshot; the run/rollback/bootstrap operations are layered on top later.
 */
export class Wiki {
  private repo!: WikiRepo;
  private roots!: { wiki: string; raw: string };
  private marker!: MarkerStore;
  private stateStore!: StateStore;
  private reconciled: ReconcileResult | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: WikiOptions) {}

  async init(): Promise<void> {
    const { home, vault, branch, run, onWarning } = this.opts;
    this.repo = new WikiRepo({ home, url: vault.url, branch, username: vault.username, token: vault.token, run, onWarning });
    const root = await this.repo.open();
    this.roots = await validateSubtreeRoots(root);
    this.marker = new MarkerStore(join(root, ".git"));
    this.stateStore = new StateStore(join(home, "state", "wiki.json"));
    this.reconciled = await this.runReconcile(await this.stateStore.read());
  }

  async status(): Promise<{ bootstrap: "pending" | "awaiting-review" | "done"; nextAttemptAt: number | null; lastBatchId: string | null }> {
    const state = await this.stateStore.read();
    const reconciled = await this.runReconcile(state);
    this.reconciled = reconciled;
    const lastBatchId = reconciled.lastBatchId ?? state?.lastBatchId ?? null;

    let bootstrap: "pending" | "awaiting-review" | "done" = "pending";
    if (lastBatchId !== null) {
      const originHead = await this.repo.originHead();
      if (!(await this.repo.isAncestor(lastBatchId, originHead))) bootstrap = "awaiting-review";
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
      await this.repo.fetch();
      const state = await this.stateStore.read();
      const reconciled = await this.runReconcile(state);
      this.reconciled = reconciled;

      const advancesScan = kind.kind !== "on-demand";
      let baseHead = "";
      let batchId = "";

      try {
        // `reconcile` already resolves a marker whose batch is in history as committed, so a
        // clean tree here is never restored; only attributable writing-phase changes are.
        await inspectAndCleanTree(this.repo, this.marker);
        if (reconciled.rollback) throw new Error("pending rollback must be settled");
        if (
          reconciled.bootstrap === "pending" &&
          reconciled.lastBatchId !== null &&
          !(await this.repo.isAncestor(reconciled.lastBatchId, await this.repo.originHead()))
        ) {
          throw new Error("bootstrap preview awaiting review");
        }
        await this.repo.rebase();
        if (!(await this.repo.isAncestor(await this.repo.head(), await this.repo.originHead()))) await this.repo.push();
        baseHead = await this.repo.head();
        batchId = randomUUID();
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
        await this.opts.runAgent(ingestPrompt(kind.kind), { repo: this.repo, marker: this.marker, roots: this.roots }, signal);
      } catch (error) {
        await abortBatch(this.repo, this.marker);
        throw error;
      }

      const inFlight = await this.marker.read();
      const touched = inFlight?.touched ?? [];
      const scanBase = inFlight?.scanBase ?? null;

      if (touched.length === 0) {
        if ((await this.repo.head()) !== (await this.repo.originHead())) {
          await abortBatch(this.repo, this.marker);
          throw new Error("wiki run advanced HEAD without recording any paths");
        }
        if (advancesScan) {
          const current = (await this.stateStore.read()) ?? emptyState();
          await this.stateStore.write({ ...current, lastScanCommit: baseHead });
        }
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
        await this.opts.notify(kind.kind === "bootstrap" ? "wiki: preview ready for review" : `wiki: ingested ${touched.length} paths`);
      }
      return { commit: sha, pages: touched.map((entry) => entry.path), pushed };
    });
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
