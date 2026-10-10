import { join } from "node:path";
import type { VaultConfig } from "../config/schema.js";
import { WikiRepo, type GitRunner } from "./git.js";
import { MarkerStore } from "./marker.js";
import { validateSubtreeRoots } from "./paths.js";
import { reconcile, type ReconcileResult } from "./reconcile.js";
import { StateStore, type WikiState } from "./state.js";

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
