import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { VaultConfig } from "../../config/schema.js";
import { abortBatch, assertBatchOwnership, assertSafeTouchedPath, ingestMessage, ingestPrompt, inspectAndCleanTree } from "./batch.js";
import { chunk, detectChanges, type Change } from "./changes.js";
import { parseTrailers, trailerValues, WikiIntegrityError, WikiRepo, type GitRunner } from "./git.js";
import { assertRecognizedLocalHistory, observeWiki } from "./integrity.js";
import { fingerprint, MarkerStore, type InFlightMarker, type TouchedPath } from "./marker.js";
import { validateSubtreeRoot, validateSubtreeRoots, wikiRawPath } from "./paths.js";
import { reconcile, RESET_TRAILER, type ReconcileResult } from "./reconcile.js";
import { emptyState, StateStore, type WikiState } from "./state.js";
import { writeWikiFile } from "./write.js";
import { WikiLock } from "./lock.js";
import { WikiReadCopy } from "./readCopy.js";
import type { NotesCopy } from "../notes.js";

export interface WikiRunResult {
  batchId: string | null;
  commit: string | null;
  pages: string[];
  publication: "not-needed" | "preview" | "published" | "pending";
}

export interface WikiRebuildResult {
  reset: boolean;
  commit: string | null;
  removed: number;
  publication: "not-needed" | "published" | "pending";
  message: string;
}

/** A source the owner asked the wiki to archive and compile. */
interface WikiSourceInput { title?: string; url?: string; canonicalUrl?: string; text?: string; truncated?: boolean; textKind?: string; metadataOnly?: boolean }
interface WikiRunRequest { kind: "scheduled" | "bootstrap" | "on-demand"; source?: WikiSourceInput }
/** A batch committed locally with its verified paths, ready to publish. */
interface CommittedBatch { sha: string; pages: string[]; rawPaths: string[]; scanBase: string | null }

/** The archived original of a source under raw/: front matter, then the text. */
function sourceDocument(source: WikiSourceInput, url: string, text: string): string {
  return ["---", `title: ${JSON.stringify(source.title ?? url)}`, `url: ${JSON.stringify(url)}`, ...(source.canonicalUrl ? [`canonical_url: ${JSON.stringify(source.canonicalUrl)}`] : []), "---", "", text, ""].join("\n");
}

const OPEN_RETRY_MS = 60_000;
const BOOTSTRAP_REF = "refs/vex/wiki-bootstrap";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wikiOutcomeText(rawPaths: string[], pages: string[], publication: "published" | "pending"): string {
  const parts = [
    rawPaths.length ? `Archived original source: ${rawPaths.join(", ")}.` : "No raw source was archived.",
    pages.length ? `Compiled Wiki pages: ${pages.join(", ")}.` : "No Wiki pages were compiled.",
    publication === "published" ? "Published to the notes repository." : "Committed locally; publication is pending.",
  ];
  return `Wiki run: ${parts.join(" ")}`;
}

/** Tells the owner a bootstrap preview exists; publishing it goes through `wiki_bootstrap` and its approval prompt. */
export function previewNotice(preview: WikiPreview): string {
  const pages = preview.pages.slice(0, 8).map((page) => `- ${page}`);
  return [
    `Wiki bootstrap preview is awaiting review: ${preview.pages.length} files, commit ${preview.commit.slice(0, 12)}. It has not been pushed.`,
    ...pages, ...(preview.pages.length > 8 ? [`${preview.pages.length - 8} more files.`] : []),
    "Say \"approve the Wiki preview\" to publish it or \"reject the Wiki preview\" to discard it; you will confirm before anything is pushed.",
  ].join("\n");
}

function splitSource(text: string, limit: number): string[] {
  const segments: string[] = [];
  let segment = "";
  let bytes = 0;
  for (const character of text) {
    const cost = Buffer.byteLength(character, "utf8");
    if (cost > limit) throw new Error("The source segment byte budget is too small for a source character.");
    if (bytes + cost > limit) {
      segments.push(segment);
      segment = "";
      bytes = 0;
    }
    segment += character;
    bytes += cost;
  }
  if (segment) segments.push(segment);
  return segments.length ? segments : [""];
}

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

export interface WikiPreview {
  batchId: string;
  commit: string;
  pages: string[];
}

export type WikiBootstrapStatus = "pending" | "awaiting-review" | "done";

export interface WikiStatus { bootstrap: WikiBootstrapStatus; nextAttemptAt: number | null; lastBatchId: string | null; bootstrapDeferred: boolean }

function statusOf(state: WikiState | null, reconciled: ReconcileResult): WikiStatus {
  // `awaiting-review` means an unpublished bootstrap preview specifically; an unpublished
  // scheduled/on-demand batch is left alone so the cadence can retry its push.
  const bootstrap: WikiBootstrapStatus = reconciled.preview
    ? "awaiting-review"
    : reconciled.bootstrap === "done"
      ? "done"
      : "pending";
  return { bootstrap, nextAttemptAt: state?.nextAttemptAt ?? null, lastBatchId: reconciled.lastBatchId, bootstrapDeferred: state?.bootstrapDeferred === true };
}

/**
 * Which wiki work the scheduler may start: a pending bootstrap once the backoff gate opens (and,
 * after the owner rejected a preview, once the cadence is due), or a scheduled run once both the gate
 * and the cadence allow it. Nothing runs while a preview awaits review.
 */
export function dueWikiWork(input: { bootstrap: WikiBootstrapStatus; gate: number | null; now: number; cadenceDue: boolean; bootstrapDeferred?: boolean }): "bootstrap" | "scheduled" | null {
  if (input.now < (input.gate ?? 0)) return null;
  if (input.bootstrap === "pending") return input.bootstrapDeferred && !input.cadenceDue ? null : "bootstrap";
  if (input.bootstrap === "done" && input.cadenceDue) return "scheduled";
  return null;
}

export interface WikiOptions {
  home: string;
  vault: VaultConfig & { url: string };
  branch?: string;
  maxNotesPerRun: number;
  notifyEnabled: boolean;
  notify: (text: string) => Promise<void>;
  runAgent: (prompt: string, context: WikiRunContext, signal: AbortSignal) => Promise<string>;
  sourceSegmentBudget?: (prefix: string, context: WikiRunContext) => Promise<number>;
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
  private readonly repo: WikiRepo;
  private roots!: { wiki: string; raw: string };
  private marker!: MarkerStore;
  private stateStore!: StateStore;
  private reconciled: ReconcileResult | null = null;
  private reconcileMemo: { key: string; result: ReconcileResult } | null = null;
  private cachedNextAttemptAt: number | null = null;
  private statusCache: { at: number; value: WikiStatus } | null = null;
  private lastStatus: WikiStatus | null = null;
  private readonly lock = new WikiLock();
  private opened = false;
  private closed = false;
  private opening: Promise<void> | null = null;
  private openRetryAt = 0;
  private openError: unknown = null;
  /** The clone as the vault reads it; it shares this lock and never waits for wiki work. */
  readonly notesCopy: NotesCopy;

  constructor(private readonly opts: WikiOptions) {
    const { home, vault, branch, run, onWarning } = opts;
    this.repo = new WikiRepo({ home, url: vault.url, branch, username: vault.username, token: vault.token, run, onWarning });
    this.notesCopy = new WikiReadCopy({
      lock: this.lock,
      open: () => this.opened ? { repo: this.repo, marker: this.marker } : undefined,
      onAdvanced: () => { this.statusCache = null; },
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.onWarning ? { onWarning: opts.onWarning } : {}),
    });
  }

  /** The writable working copy root, which general file tools must not touch. */
  get root(): string {
    return this.repo.root;
  }

  /** Reminds the owner of a bootstrap preview left unpublished by an earlier process. */
  async remindPendingPreview(): Promise<void> {
    if (!this.opts.notifyEnabled) return;
    await this.ready();
    const preview = await this.preview();
    if (preview) await this.opts.notify(previewNotice(preview));
  }

  /** Synchronous backoff gate for the scheduler. */
  nextAttemptAt(): number | null {
    return this.cachedNextAttemptAt;
  }

  /**
   * Opens the clone in the background, then reminds the owner of a pending preview. Wiki work
   * waits for an open in progress; after a failed open, it is retried no sooner than a minute later.
   */
  start(): void {
    if (this.opened || this.opening || this.clock() < this.openRetryAt) return;
    this.init().then(
      () => this.closed ? undefined : this.remindPendingPreview().catch((error: unknown) => this.opts.onWarning?.(`wiki: preview reminder failed: ${errorText(error)}`)),
      (error: unknown) => this.opts.onWarning?.(`wiki: could not open the vault clone: ${errorText(error)}`),
    );
  }

  /** Clones on first use and reconciles history; concurrent callers share one attempt. */
  async init(): Promise<void> {
    if (this.opened) return;
    this.opening ??= this.open().then(
      () => { this.opened = true; this.opening = null; this.openError = null; },
      (error: unknown) => { this.opening = null; this.openError = error; this.openRetryAt = this.clock() + OPEN_RETRY_MS; throw error; },
    );
    await this.opening;
  }

  private async ready(): Promise<void> {
    if (this.opened) return;
    if (!this.opening && this.clock() < this.openRetryAt) throw new Error(`wiki is not available yet: ${errorText(this.openError)}`);
    await this.init();
  }

  private clock(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async open(): Promise<void> {
    const root = await this.repo.open();
    this.roots = await validateSubtreeRoots(root);
    this.marker = new MarkerStore(join(root, ".git"));
    this.stateStore = new StateStore(join(this.opts.home, "state", "wiki.json"));
    const state = await this.stateStore.read();
    this.cachedNextAttemptAt = state?.nextAttemptAt ?? null;
    this.reconciled = await this.runReconcile(state);
    this.lastStatus = statusOf(state, this.reconciled);
    this.statusCache = null;
  }

  /** The work the scheduler may start now; see `dueWikiWork`. */
  async dueWork(now: number, cadenceDue: boolean): Promise<"bootstrap" | "scheduled" | null> {
    if (!this.opened) { this.start(); return null; }
    const gate = this.nextAttemptAt();
    if (gate !== null && now < gate) return null;
    // Only a pending bootstrap can start off-cadence; an idle wiki reads no history between runs.
    if (!cadenceDue && this.lastStatus && this.lastStatus.bootstrap !== "pending") return null;
    const { bootstrap, bootstrapDeferred } = await this.status();
    return dueWikiWork({ bootstrap, gate, now, cadenceDue, bootstrapDeferred });
  }

  async status(): Promise<WikiStatus> {
    // `status()` is polled every scheduler tick; cache briefly so an idle wiki does no history scans.
    if (this.statusCache && this.clock() - this.statusCache.at < 10_000) return this.statusCache.value;
    await this.ready();
    // A running operation may be mid-rebase; report the last settled status instead of reading history.
    if (this.lock.busy && this.lastStatus) return this.lastStatus;
    const state = await this.stateStore.read();
    const reconciled = await this.runReconcile(state);
    this.reconciled = reconciled;
    this.cachedNextAttemptAt = state?.nextAttemptAt ?? null;
    const value = statusOf(state, reconciled);
    this.lastStatus = value;
    this.statusCache = { at: this.clock(), value };
    return value;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.reconciled = null;
    this.statusCache = null;
  }

  async run(request: WikiRunRequest, signal: AbortSignal): Promise<WikiRunResult> {
    if (request.kind === "on-demand" && request.source?.url && !request.source.text?.trim()) {
      return { batchId: null, commit: null, pages: [], publication: "not-needed" };
    }
    await this.ready();
    return this.lock.run(async () => {
      try {
        return await this.runLocked(request, signal);
      } catch (error) {
        const failureStreak = await this.recordFailure();
        // A run of consecutive failures is reported once, when it starts.
        if (this.opts.notifyEnabled && failureStreak === 1) await this.opts.notify(`wiki: run failed: ${(error as Error).message}`).catch(() => undefined);
        throw error;
      }
    }, signal);
  }

  /** One run under the lock: settle the previous batch, write a new one, then commit and publish it. */
  private async runLocked(request: WikiRunRequest, signal: AbortSignal): Promise<WikiRunResult> {
    const { state, reconciled, pendingCompile } = await this.fetchAndReconcile(request);
    const settled = await this.settlePrevious(request, state, reconciled, pendingCompile, signal);
    if ("result" in settled) return settled.result;
    const { baseHead } = settled;
    const advancesScan = request.kind !== "on-demand";
    let batchId: string;
    if (request.kind !== "on-demand") {
      // A compile run ingests every note added since the last scan, splitting them across as
      // many agent calls as `maxNotesPerRun` allows. On-demand runs skip detection entirely.
      const changes = await this.changesSince(reconciled.lastScanCommit ?? null);
      if (changes.length === 0) {
        await this.recordNoChange(request.kind, advancesScan, baseHead);
        return { batchId: null, commit: null, pages: [], publication: "not-needed" };
      }
      batchId = await this.compileChanges(request.kind, changes, baseHead, signal);
    } else {
      batchId = await this.ingestSource(request, baseHead, signal);
    }
    const committed = await this.commitBatch(request.kind, batchId, baseHead, advancesScan);
    if ("result" in committed) return committed.result;
    return this.publishBatch(request.kind, batchId, committed, advancesScan, signal);
  }

  /** Fetches, reconciles durable state and checks integrity before any path is restored or removed. */
  private async fetchAndReconcile(request: WikiRunRequest): Promise<{ state: WikiState | null; reconciled: ReconcileResult; pendingCompile: InFlightMarker | null }> {
    await this.repo.fetch();
    const state = await this.stateStore.read();
    if (request.kind === "bootstrap" && state?.bootstrapDeferred) {
      const { bootstrapDeferred: _deferred, ...rest } = state;
      await this.stateStore.write(rest);
    }
    const reconciled = await this.runReconcile(state);
    this.reconciled = reconciled;
    const pendingCompile = reconciled.markerResolution === "committed" ? await this.marker.read() : null;
    // Refuse before recovery cleanup can restore or remove any paths.
    await this.checkIntegrity();
    if (reconciled.preview) throw new Error("bootstrap preview awaiting review");
    return { state, reconciled, pendingCompile };
  }

  /**
   * Cleans the tree, settles a pending rollback and publishes a committed batch left by an earlier run.
   * Returns the head the new batch builds on, or the settled batch's receipt when it already archived
   * this request's source. A committed batch that cannot be settled is kept and reported as pending.
   */
  private async settlePrevious(
    request: WikiRunRequest, state: WikiState | null, reconciled: ReconcileResult, pendingCompile: InFlightMarker | null, signal: AbortSignal,
  ): Promise<{ result: WikiRunResult } | { baseHead: string }> {
    try {
      if (pendingCompile) {
        if (!(await this.cleanTree())) throw new WikiIntegrityError("committed wiki batch has a dirty tree; preserving its marker");
      } else {
        await inspectAndCleanTree(this.repo, this.marker);
      }
      // Settle a committed-but-unpublished rollback only after the tree is clean, so its rebase cannot fail on leftovers.
      if (reconciled.rollback || state?.rollback) await this.settleRollback(state, reconciled, signal);
      await this.checkIntegrity();
      await this.repo.rebase();
      if (pendingCompile) {
        const result = await this.settleCommittedBatch(request, pendingCompile, signal);
        if (result) return { result };
      }
      if (!pendingCompile && !(await this.repo.isAncestor(await this.repo.head(), await this.repo.originHead()))) await this.repo.push();
      return { baseHead: await this.repo.head() };
    } catch (error) {
      if (pendingCompile) {
        try { await this.recordFailure(); } catch { /* keep the committed marker and return its receipt */ }
        const pendingSha = pendingCompile.commit ?? await this.findCommit("Vex-Batch", pendingCompile.batchId).catch(() => null);
        const pendingPages = pendingSha ? (await this.repo.changedPaths(pendingSha)).filter((path) => path.startsWith("wiki/")) : [];
        return { result: { batchId: pendingCompile.batchId, commit: pendingSha, pages: pendingPages, publication: "pending" } };
      }
      if (error instanceof WikiIntegrityError) throw error;
      await abortBatch(this.repo, this.marker);
      throw error;
    }
  }

  /** Publishes a committed batch and clears its marker; returns its receipt when it archived this request's source unchanged. */
  private async settleCommittedBatch(request: WikiRunRequest, pendingCompile: InFlightMarker, signal: AbortSignal): Promise<WikiRunResult | undefined> {
    let settledSha = await this.findCommit("Vex-Batch", pendingCompile.batchId);
    if (!settledSha) throw new WikiIntegrityError("committed wiki batch is missing during settlement; preserving marker");
    await this.validateCommittedMarker();
    if (!(await this.repo.isAncestor(settledSha, await this.repo.originHead()))) await this.pushWithRetry(false, signal);
    settledSha = await this.findCommit("Vex-Batch", pendingCompile.batchId) ?? settledSha;
    await this.marker.setCommitted(settledSha);
    const current = (await this.stateStore.read()) ?? emptyState();
    await this.stateStore.write({
      ...current,
      lastBatchId: pendingCompile.batchId,
      lastScanCommit: pendingCompile.advancesScan ? pendingCompile.scanBase : current.lastScanCommit,
      rollback: null,
      failureStreak: 0,
      nextAttemptAt: null,
      lastRunAt: this.clock(),
    });
    await this.marker.remove();
    this.cachedNextAttemptAt = null;
    this.statusCache = null;
    const settledPages = (await this.repo.changedPaths(settledSha)).filter((path) => path.startsWith("wiki/"));
    const source = request.kind === "on-demand" ? request.source : undefined;
    const url = source?.url;
    if (!source || !url) return undefined;
    const pendingSource = pendingCompile.touched.find((entry) => entry.path === this.sourcePath(url));
    if (!pendingSource) return undefined;
    const expectedHash = createHash("sha256").update(sourceDocument(source, url, source.text ?? "")).digest("hex");
    return pendingSource.after?.hash === expectedHash ? { batchId: pendingCompile.batchId, commit: settledSha, pages: settledPages, publication: "published" } : undefined;
  }

  /** Vault changes since the last scanned commit, or the whole history when that commit is no longer an ancestor. */
  private async changesSince(cursor: string | null): Promise<Change[]> {
    const from = cursor !== null && !(await this.repo.isAncestor(cursor, await this.repo.head())) ? null : cursor;
    return detectChanges(this.repo, from);
  }

  /** Records a run that found nothing to commit: the scan advances and the backoff resets. */
  private async recordNoChange(kind: WikiRunRequest["kind"], advancesScan: boolean, baseHead: string): Promise<void> {
    const current = (await this.stateStore.read()) ?? emptyState();
    await this.stateStore.write({ ...current, lastScanCommit: advancesScan ? baseHead : current.lastScanCommit, failureStreak: 0, nextAttemptAt: null, ...(kind === "bootstrap" ? { bootstrap: "done" as const } : {}) });
    if (kind === "bootstrap") await this.repo.updateRef(BOOTSTRAP_REF, baseHead);
    this.cachedNextAttemptAt = null;
    this.statusCache = null;
  }

  /** Opens a batch and lets the compiler agent apply the changes chunk by chunk; returns the batch id. */
  private async compileChanges(kind: "scheduled" | "bootstrap", changes: Change[], baseHead: string, signal: AbortSignal): Promise<string> {
    const batchId = randomUUID();
    try {
      await this.marker.begin({ batchId, kind, advancesScan: true, scanBase: baseHead, baseHead, phase: "writing", commit: null, touched: [] });
      for (const part of chunk(changes, this.opts.maxNotesPerRun)) {
        await this.opts.runAgent(this.chunkPrompt(part), this.runContext(), signal);
      }
    } catch (error) {
      await abortBatch(this.repo, this.marker);
      throw error;
    }
    return batchId;
  }

  /** Opens a batch, archives the request's source under raw/ and compiles it segment by segment; returns the batch id. */
  private async ingestSource(request: WikiRunRequest, baseHead: string, signal: AbortSignal): Promise<string> {
    const batchId = randomUUID();
    try {
      const body = request.source?.text ?? "";
      let sourceSegmentLimit = 12_000;
      if (request.source?.url && body && this.opts.sourceSegmentBudget) {
        const prefix = this.sourcePrompt(request, "", 999, 999);
        sourceSegmentLimit = Math.max(1, Math.min(sourceSegmentLimit, await this.opts.sourceSegmentBudget(prefix, this.runContext())));
      }
      const segments = request.source?.url && body ? splitSource(body, sourceSegmentLimit) : [body];
      await this.marker.begin({ batchId, kind: request.kind, advancesScan: false, scanBase: null, baseHead, phase: "writing", commit: null, touched: [] });
      if (request.source?.url && request.source.text !== undefined && request.source.text.trim()) {
        if (request.source.truncated) throw new Error("The retrieved source is truncated and cannot be archived as a complete original.");
        signal.throwIfAborted();
        const path = this.sourcePath(request.source.url);
        const content = sourceDocument(request.source, request.source.url, request.source.text);
        const current = await fingerprint(join(this.repo.root, path));
        const hash = createHash("sha256").update(content).digest("hex");
        if (current.type !== "file" || current.hash !== hash) {
          await writeWikiFile(this.runContext(), path, content);
        }
      }
      for (let index = 0; index < segments.length; index++) {
        signal.throwIfAborted();
        await this.opts.runAgent(this.sourcePrompt(request, segments[index] ?? "", index + 1, segments.length), this.runContext(), signal);
      }
    } catch (error) {
      await abortBatch(this.repo, this.marker);
      throw error;
    }
    return batchId;
  }

  private runContext(): WikiRunContext {
    return { repo: this.repo, marker: this.marker, roots: this.roots };
  }

  /**
   * Verifies the batch's recorded paths against the tree and commits the ones that changed. Returns the
   * receipt directly when nothing needed committing, or when the commit could not be fully recorded.
   */
  private async commitBatch(
    kind: WikiRunRequest["kind"], batchId: string, baseHead: string, advancesScan: boolean,
  ): Promise<{ result: WikiRunResult } | CommittedBatch> {
    const inFlight = await this.marker.read();
    const touched = inFlight?.touched ?? [];
    const scanBase = inFlight?.scanBase ?? null;

    if (touched.length === 0) {
      const dirty = await this.repo.statusEntries();
      if (dirty.length > 0) {
        await abortBatch(this.repo, this.marker);
        throw new Error("wiki run produced dirty paths without recording them in the batch");
      }
      if ((await this.repo.head()) !== (await this.repo.originHead())) {
        await abortBatch(this.repo, this.marker);
        throw new Error("wiki run advanced HEAD without recording any paths");
      }
      await this.recordNoChange(kind, advancesScan, baseHead);
      await this.marker.remove();
      return { result: { batchId, commit: null, pages: [], publication: "not-needed" } };
    }

    let sha: string;
    let committedPaths: string[];
    try {
      const changedTouched = await this.verifiedChanges(touched, baseHead);
      if (changedTouched.length === 0) {
        const before = new Map(await Promise.all(touched.map(async (entry) => [entry.path, await this.repo.fingerprintAt(baseHead, entry.path)] as const)));
        const after = new Map(touched.map((entry) => [entry.path, entry.after!]));
        await this.repo.assertIndexFingerprints(before, after);
        await this.recordNoChange(kind, advancesScan, baseHead);
        await this.marker.remove();
        return { result: { batchId, commit: null, pages: [], publication: "not-needed" } };
      }
      sha = await this.repo.commit(
        changedTouched.map((entry) => entry.path),
        ingestMessage(kind, batchId, scanBase, changedTouched.length, new Date()),
        new Map(changedTouched.map((entry) => [entry.path, entry.after!])),
        new Map(await Promise.all(changedTouched.map(async (entry) => [entry.path, await this.repo.fingerprintAt(baseHead, entry.path)] as const))),
      );
      committedPaths = await this.committedPathsMatching(sha, changedTouched);
    } catch (error) {
      const recovered = await this.recoverCommittedBatch(batchId, error);
      if (recovered) return { result: recovered };
      throw error;
    }
    const pages = committedPaths.filter((path) => path.startsWith("wiki/"));
    const rawPaths = committedPaths.filter((path) => path.startsWith("raw/"));
    try {
      await this.marker.setCommitted(sha);
    } catch {
      try { await this.recordFailure(); } catch { /* the writing marker and commit trailer remain sufficient for recovery */ }
      this.statusCache = null;
      await this.notifyOutcome(wikiOutcomeText(rawPaths, pages, "pending"));
      return { result: { batchId, commit: sha, pages, publication: "pending" } };
    }
    return { sha, pages, rawPaths, scanBase };
  }

  /** Checks every recorded path still holds what the batch wrote; returns those that differ from the base head. */
  private async verifiedChanges(touched: TouchedPath[], baseHead: string): Promise<TouchedPath[]> {
    if ((await this.repo.head()) !== baseHead) throw new Error("wiki run changed HEAD before committing the batch");
    for (const entry of touched) {
      await assertSafeTouchedPath(this.repo, entry.path);
      const current = await fingerprint(join(this.repo.root, entry.path));
      const expected = entry.after;
      if (!expected || current.type !== expected.type || current.hash !== expected.hash) {
        throw new Error(`wiki path changed since the batch recorded it: ${entry.path}`);
      }
    }
    await this.checkIntegrity();
    await assertBatchOwnership(this.repo, touched);
    const changedTouched = [];
    for (const entry of touched) {
      const baseline = await this.repo.fingerprintAt(baseHead, entry.path);
      if (!entry.after || baseline.type !== entry.after.type || baseline.hash !== entry.after.hash) changedTouched.push(entry);
    }
    return changedTouched;
  }

  /** The commit's paths, after checking it holds exactly the batch's paths with the recorded content. */
  private async committedPathsMatching(sha: string, changedTouched: TouchedPath[]): Promise<string[]> {
    const committedPaths = await this.repo.changedPaths(sha);
    const owned = new Set(changedTouched.map((entry) => entry.path));
    const unexpected = committedPaths.filter((path) => !owned.has(path));
    if (unexpected.length) throw new WikiIntegrityError(`wiki commit includes unowned paths: ${unexpected.join(", ")}`);
    for (const path of committedPaths) {
      const expected = changedTouched.find((entry) => entry.path === path)?.after;
      const actual = await this.repo.fingerprintAt(sha, path);
      if (!expected || expected.type !== actual.type || expected.hash !== actual.hash) {
        throw new WikiIntegrityError(`wiki commit content does not match the batch: ${path}`);
      }
    }
    return committedPaths;
  }

  /**
   * After a failed commit step, keeps a batch that reconciliation shows was committed intact and
   * returns its pending receipt; otherwise aborts the batch unless the failure was an integrity error.
   */
  private async recoverCommittedBatch(batchId: string, error: unknown): Promise<WikiRunResult | undefined> {
    const integrityFailure = error instanceof WikiIntegrityError;
    const state = await this.stateStore.read();
    const recovered = await this.runReconcile(state);
    if (recovered.markerResolution !== "committed") {
      if (!integrityFailure) await abortBatch(this.repo, this.marker);
      return undefined;
    }
    const recoveredBatch = await this.marker.read();
    const recoveredSha = recoveredBatch?.batchId === batchId ? await this.findCommit("Vex-Batch", batchId) : null;
    if (recoveredBatch?.batchId !== batchId || !recoveredSha) return undefined;
    await this.validateCommittedMarker();
    const committedPaths = await this.repo.changedPaths(recoveredSha);
    const ownedPaths = new Set(recoveredBatch.touched.map((entry) => entry.path));
    if (committedPaths.some((path) => !ownedPaths.has(path))) throw new WikiIntegrityError("recovered wiki commit contains paths outside its marker");
    for (const path of committedPaths) {
      const expected = recoveredBatch.touched.find((entry) => entry.path === path)?.after;
      const actual = await this.repo.fingerprintAt(recoveredSha, path);
      if (!expected || actual.type !== expected.type || actual.hash !== expected.hash) {
        throw new WikiIntegrityError(`recovered wiki commit does not match its marker: ${path}`);
      }
    }
    try { await this.marker.setCommitted(recoveredSha); } catch { /* reconciliation can finish from the durable batch trailer */ }
    try { await this.recordFailure(); } catch { /* the durable batch marker remains the recovery record */ }
    const recoveredPages = committedPaths.filter((path) => path.startsWith("wiki/"));
    const recoveredRaw = committedPaths.filter((path) => path.startsWith("raw/"));
    await this.notifyOutcome(wikiOutcomeText(recoveredRaw, recoveredPages, "pending"));
    return { batchId, commit: recoveredSha, pages: recoveredPages, publication: "pending" };
  }

  /** Pushes a committed batch (a bootstrap preview stays local), records it and notifies the owner. */
  private async publishBatch(
    kind: WikiRunRequest["kind"], batchId: string, committed: CommittedBatch, advancesScan: boolean, signal: AbortSignal,
  ): Promise<WikiRunResult> {
    let { sha } = committed;
    const { pages, rawPaths, scanBase } = committed;
    let pushed = false;
    try {
      if (kind !== "bootstrap") {
        await this.pushWithRetry(false, signal);
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
        lastRunAt: this.clock(),
      });
      await this.marker.remove();
    } catch {
      await this.notifyOutcome(wikiOutcomeText(rawPaths, pages, "pending"));
      try { await this.recordFailure(); } catch { /* the committed marker remains the durable recovery record */ }
      this.statusCache = null;
      return { batchId, commit: sha, pages, publication: "pending" };
    }

    await this.notifyOutcome(kind === "bootstrap"
      ? previewNotice({ batchId, commit: sha, pages })
      : wikiOutcomeText(rawPaths, pages, pushed ? "published" : "pending"));
    this.cachedNextAttemptAt = null;
    this.statusCache = null;
    return { batchId, commit: sha, pages, publication: kind === "bootstrap" ? "preview" : pushed ? "published" : "pending" };
  }

  private async notifyOutcome(text: string): Promise<void> {
    if (this.opts.notifyEnabled) await this.opts.notify(text).catch(() => undefined);
  }

  /** Records a failed run and the exponential backoff that gates the next attempt; returns the consecutive failure count. */
  private async recordFailure(): Promise<number> {
    const current = (await this.stateStore.read()) ?? emptyState();
    const failureStreak = current.failureStreak + 1;
    const backoff = Math.min(60 * 60_000, 5 * 60_000 * 2 ** (failureStreak - 1));
    const nextAttemptAt = this.clock() + backoff;
    await this.stateStore.write({ ...current, failureStreak, nextAttemptAt });
    this.cachedNextAttemptAt = nextAttemptAt;
    return failureStreak;
  }

  /** Reverts the most recent committed compile batch exactly once, or completes a pending rollback. */
  async rollback(signal: AbortSignal): Promise<WikiRollbackResult> {
    signal.throwIfAborted();
    await this.ready();
    return this.lock.run(async () => {
      this.statusCache = null;
      await this.repo.fetch();
      const state = await this.stateStore.read();
      const reconciled = await this.runReconcile(state);

      if (reconciled.rollback || state?.rollback) {
        const clean = await this.cleanTree();
        if (!clean) return { reverted: false, commit: null, message: "working tree or index is not clean; pending rollback kept" };
        try {
          await this.settleRollback(state, reconciled, signal);
        } catch (error) {
          if (error instanceof WikiIntegrityError) return { reverted: false, commit: null, message: error.message };
          throw error;
        }
        return { reverted: true, commit: await this.repo.head(), message: "completed a pending rollback" };
      }

      if (!(await this.cleanTree())) return { reverted: false, commit: null, message: "working tree or index is not clean" };

      await this.checkIntegrity();
      const batchId = reconciled.lastBatchId;
      if (!batchId) return { reverted: false, commit: null, message: "there is nothing to roll back" };

      const head = await this.repo.head();
      const origin = await this.repo.originHead();
      if (head !== origin && await this.repo.isAncestor(head, origin)) {
        if (!(await this.cleanTree())) return { reverted: false, commit: null, message: "working tree or index changed; rollback stopped" };
        await this.repo.fastForward();
        await this.checkIntegrity();
      }

      const target = await this.findCommit("Vex-Batch", batchId);
      if (!target) {
        await this.clearBatchRef();
        return { reverted: false, commit: null, message: "the last batch no longer exists" };
      }

      if (!(await this.repo.isAncestor(target, await this.repo.originHead()))) {
        if ((await this.repo.head()) !== target) return { reverted: false, commit: null, message: "the unpublished batch is not the local tip; kept" };
        await this.checkIntegrity();
        if (!(await this.cleanTree())) return { reverted: false, commit: null, message: "working tree or index changed; unpublished batch kept" };
        signal.throwIfAborted();
        await this.repo.resetHard(`${target}^`);
        await this.clearBatchRef();
        return { reverted: true, commit: await this.repo.head(), message: "discarded the unpublished batch" };
      }

      const revertId = randomUUID();
      let revertSha: string;
      try {
        await this.checkIntegrity();
        if (!(await this.cleanTree())) return { reverted: false, commit: null, message: "working tree or index changed; rollback stopped" };
        signal.throwIfAborted();
        revertSha = await this.repo.revert(target, `wiki: rollback ${batchId}\n\nVex-Rollback: ${revertId}\nVex-Revert-Of: ${batchId}`);
      } catch (error) {
        if (error instanceof WikiIntegrityError) return { reverted: false, commit: null, message: error.message };
        return { reverted: false, commit: null, message: `revert failed: ${(error as Error).message}` };
      }

      const current = (await this.stateStore.read()) ?? emptyState();
      await this.stateStore.write({ ...current, rollback: { targetBatchId: batchId, revertId } });
      if (!(await this.cleanTree())) return { reverted: false, commit: revertSha, message: "rollback committed locally but the tree changed; publication is pending" };
      try {
        signal.throwIfAborted();
        await this.pushWithRetry(true, signal);
      } catch {
        return { reverted: false, commit: revertSha, message: "revert committed locally but push failed; a later run will complete it" };
      }
      await this.clearBatchRef();
      return { reverted: true, commit: await this.repo.head(), message: "reverted the last batch" };
    }, signal);
  }

  /** Returns the local bootstrap preview awaiting owner review. */
  async preview(): Promise<WikiPreview | null> {
    const status = await this.status();
    if (status.bootstrap !== "awaiting-review" || !status.lastBatchId) return null;
    const commit = await this.findCommit("Vex-Batch", status.lastBatchId);
    if (!commit) return null;
    const changes = await this.repo.diffNames(`${commit}^`, commit, "*.md");
    return { batchId: status.lastBatchId, commit, pages: changes.map((entry) => entry.path) };
  }

  async approveBootstrap(signal: AbortSignal): Promise<{ pushed: boolean; message: string }> {
    signal.throwIfAborted();
    await this.ready();
    return this.lock.run(async () => {
      this.statusCache = null;
      await this.repo.fetch();
      const state = await this.stateStore.read();
      const reconciled = await this.runReconcile(state);
      if (!(await this.cleanTree())) return { pushed: false, message: "working tree or index is not clean; preview kept" };
      await this.checkIntegrity();
      const batchId = reconciled.lastBatchId;
      const commit = batchId === null ? null : await this.findCommit("Vex-Batch", batchId);
      if (commit === null || !(await this.isBootstrapPreview(commit, batchId)) || !reconciled.preview || reconciled.bootstrap !== "pending" || (await this.repo.isAncestor(commit, await this.repo.originHead()))) {
        return { pushed: false, message: "there is nothing to approve" };
      }
      try {
        signal.throwIfAborted();
        await this.pushWithRetry(true, signal);
      } catch (error) {
        return { pushed: false, message: `could not publish the preview: ${(error as Error).message}` };
      }
      const current = (await this.stateStore.read()) ?? emptyState();
      await this.stateStore.write({ ...current, bootstrap: "done", lastRunAt: this.clock() });
      return { pushed: true, message: "bootstrap preview published" };
    }, signal);
  }

  /** Discards an unpublished bootstrap preview locally, or marks it done when it was already published. */
  async rejectBootstrap(signal: AbortSignal): Promise<{ discarded: boolean; message: string }> {
    signal.throwIfAborted();
    await this.ready();
    return this.lock.run(async () => {
      this.statusCache = null;
      await this.repo.fetch();
      const state = await this.stateStore.read();
      const reconciled = await this.runReconcile(state);
      if (!(await this.cleanTree())) return { discarded: false, message: "working tree or index is not clean; preview kept" };
      await this.checkIntegrity();
      const batchId = reconciled.lastBatchId;
      const commit = batchId === null ? null : await this.findCommit("Vex-Batch", batchId);
      if (commit === null || !(await this.isBootstrapPreview(commit, batchId))) return { discarded: false, message: "there is no bootstrap preview to reject" };

      const current = (await this.stateStore.read()) ?? emptyState();
      if (await this.repo.isAncestor(commit, await this.repo.originHead())) {
        await this.stateStore.write({ ...current, bootstrap: "done" });
        return { discarded: false, message: "the preview was already published; bootstrap marked done" };
      }
      if (!reconciled.preview || (await this.repo.head()) !== commit) return { discarded: false, message: "the unpublished preview is not the local tip; kept" };

      await this.checkIntegrity();
      if (!(await this.cleanTree())) return { discarded: false, message: "working tree or index changed; preview kept" };
      signal.throwIfAborted();
      await this.repo.resetHard(`${commit}^`);
      await this.marker.remove();
      await this.stateStore.write({ ...current, lastBatchId: null, rollback: null, bootstrap: "pending", bootstrapDeferred: true });
      return { discarded: true, message: "bootstrap preview discarded; a new preview waits for the next scheduled run" };
    }, signal);
  }

  /**
   * Starts the wiki over: one reset commit removes the generated wiki/ pages and opens a new epoch in
   * which earlier batches, cursors and the old bootstrap no longer count, so the scheduler compiles
   * every note and archived raw source into a new bootstrap preview for the owner to review.
   */
  async rebuild(signal: AbortSignal): Promise<WikiRebuildResult> {
    signal.throwIfAborted();
    await this.ready();
    return this.lock.run(async () => {
      const refused = (message: string): WikiRebuildResult => ({ reset: false, commit: null, removed: 0, publication: "not-needed", message });
      this.statusCache = null;
      await this.repo.fetch();
      const state = await this.stateStore.read();
      const reconciled = await this.runReconcile(state);
      if (await this.marker.read()) return refused("a wiki batch is still being settled; try again after the next run");
      if (reconciled.preview) return refused("a bootstrap preview awaits review; approve or reject it first");
      if (reconciled.rollback || state?.rollback) return refused("a rollback is still being published; try again after the next run");
      if (!(await this.cleanTree())) return refused("working tree or index is not clean");
      await this.checkIntegrity();
      await this.repo.fastForward();
      if ((await this.repo.head()) !== (await this.repo.originHead())) return refused("unpublished wiki commits exist; the next run publishes them first");
      signal.throwIfAborted();
      const resetId = randomUUID();
      const { commit, removed } = await this.repo.commitWikiRemoval(`wiki: rebuild\n\n${RESET_TRAILER}: ${resetId}`);
      await this.stateStore.write({ ...emptyState(), resetId });
      if (await this.repo.ref(BOOTSTRAP_REF)) await this.repo.deleteRef(BOOTSTRAP_REF);
      this.roots = await validateSubtreeRoots(this.repo.root);
      this.lastStatus = null;
      this.cachedNextAttemptAt = null;
      try {
        signal.throwIfAborted();
        await this.pushWithRetry(true, signal);
      } catch (error) {
        return { reset: true, commit, removed, publication: "pending", message: `the reset was committed locally but not pushed (${errorText(error)}); the next run publishes it before compiling` };
      }
      return { reset: true, commit: await this.repo.head(), removed, publication: "published", message: `removed ${removed} wiki pages; every note will be compiled into a new bootstrap preview for review` };
    }, signal);
  }

  private sourcePath(url: string): string {
    return wikiRawPath(url);
  }

  /** The one-shot prompt for an on-demand run, carrying the requesting source when present. */
  private sourcePrompt(kind: WikiRunRequest, segment: string, segmentIndex: number, segmentCount: number): string {
    const lines = [ingestPrompt(kind.kind)];
    if (kind.source?.title) lines.push(`Source title: ${kind.source.title}`);
    if (kind.source?.url) {
      lines.push(`Source URL: ${kind.source.url}`);
      if (kind.source.canonicalUrl) lines.push(`Canonical source URL: ${kind.source.canonicalUrl}`);
      if (kind.source.text?.trim()) lines.push(`Source archived at: ${this.sourcePath(kind.source.url)}. Preserve its original text and cite this path in wiki page sources.`);
      else if (kind.source.metadataOnly) lines.push("This source has metadata only; no original body is available to archive.");
    }
    if (kind.source?.url && kind.source.text?.trim()) lines.push(`Source segment ${segmentIndex} of ${segmentCount}. Raw archive: ${this.sourcePath(kind.source.url)}. Use this segment only; all segments belong to the same source and batch.`);
    if (segment) lines.push(`Source text:\n${segment}`);
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
    await this.checkIntegrity();
    const parts = (await this.repo.log("HEAD")).split("\0");
    const matches: string[] = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const sha = (parts[index] ?? "").trim();
      const body = parts[index + 1] ?? "";
      const trailers = parseTrailers(body);
      const found = trailerValues(trailers, trailer).includes(value);
      if (found) matches.push(sha);
    }
    if (matches.length > 1) throw new Error(`ambiguous ${trailer} identity ${value}`);
    return matches[0] ?? null;
  }

  /** Publishes a pending rollback, clearing the batch reference; throws when the push cannot complete. */
  private async settleRollback(state: WikiState | null, reconciled: ReconcileResult, signal: AbortSignal): Promise<void> {
    if (!(await this.cleanTree())) throw new WikiIntegrityError("wiki tree or index is dirty; pending rollback preserved");
    const pending = reconciled.rollback;
    if (!pending) {
      if (!state?.rollback) return;
      const stateCommit = await this.findCommit("Vex-Rollback", state.rollback.revertId);
      if (!stateCommit) throw new WikiIntegrityError("pending rollback reference has no matching rollback commit; preserving state");
      const body = (await this.repo.log(stateCommit)).split("\0")[1] ?? "";
      const trailers = parseTrailers(body);
      const targetIds = trailerValues(trailers, "vex-revert-of");
      if (targetIds.length !== 1 || targetIds[0] !== state.rollback.targetBatchId) throw new WikiIntegrityError("pending rollback target does not match its commit; preserving state");
      if (!(await this.repo.isAncestor(stateCommit, await this.repo.originHead()))) throw new WikiIntegrityError("pending rollback is not the reconciled history tip; preserving state");
      await this.clearBatchRef();
      return;
    }
    const rollbackCommit = await this.findCommit("Vex-Rollback", pending.revertId);
    if (!rollbackCommit) throw new WikiIntegrityError("pending rollback commit is missing; preserving state");
    const trailers = parseTrailers((await this.repo.log(rollbackCommit)).split("\0")[1] ?? "");
    const targetIds = trailerValues(trailers, "vex-revert-of");
    if (targetIds.length !== 1 || targetIds[0] !== pending.targetBatchId) throw new WikiIntegrityError("pending rollback target does not match its commit; preserving state");
    if (await this.repo.isAncestor(rollbackCommit, await this.repo.originHead())) {
      await this.clearBatchRef();
      return;
    }
    signal.throwIfAborted();
    await this.pushWithRetry(true, signal);
    await this.clearBatchRef();
  }

  private async cleanTree(): Promise<boolean> {
    return (await this.repo.statusEntries()).length === 0;
  }

  private async isBootstrapPreview(commit: string, batchId: string | null): Promise<boolean> {
    if (batchId === null || (await this.findCommit("Vex-Batch", batchId)) !== commit) return false;
    const fields = (await this.repo.log(commit)).split("\0");
    const body = fields[1] ?? "";
    const trailers = parseTrailers(body);
    const kinds = trailerValues(trailers, "vex-kind");
    return kinds.length === 1 && kinds[0] === "bootstrap";
  }

  private async clearBatchRef(): Promise<void> {
    const current = (await this.stateStore.read()) ?? emptyState();
    await this.stateStore.write({ ...current, lastBatchId: null, rollback: null });
  }

  /** Pushes the committed batch; on a rejected push it integrates the remote once and retries, accepting an already-published HEAD. */
  private async pushWithRetry(requireClean = false, signal?: AbortSignal): Promise<void> {
    try {
      await this.checkIntegrity();
      if (requireClean && !(await this.cleanTree())) throw new WikiIntegrityError("wiki tree or index is dirty; refusing publication");
      signal?.throwIfAborted();
      await this.repo.push();
      return;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof WikiIntegrityError) throw error;
      // Another writer advanced the remote; fetch, rebase and retry once.
    }
    await this.repo.fetch();
    await this.checkIntegrity();
    if (requireClean && !(await this.cleanTree())) throw new WikiIntegrityError("wiki tree or index is dirty; refusing rebase");
    signal?.throwIfAborted();
    await this.repo.rebase();
    try {
      await this.checkIntegrity();
      if (requireClean && !(await this.cleanTree())) throw new WikiIntegrityError("wiki tree or index is dirty; refusing publication");
      signal?.throwIfAborted();
      await this.repo.push();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof WikiIntegrityError) throw error;
      await this.repo.fetch();
      await this.checkIntegrity();
      if (requireClean && !(await this.cleanTree())) throw new WikiIntegrityError("wiki tree or index is dirty; refusing publication");
      if (await this.repo.isAncestor(await this.repo.head(), await this.repo.originHead())) return;
      throw error;
    }
  }

  /** Reconciles history; the result is reused while the refs, state and marker it was built from are unchanged. */
  private async runReconcile(state: WikiState | null): Promise<ReconcileResult> {
    const marker = await this.marker.read();
    const bootstrapRef = await this.repo.ref(BOOTSTRAP_REF);
    const key = JSON.stringify([await this.repo.head(), await this.repo.originHead(), bootstrapRef, state, marker]);
    let result = this.reconcileMemo?.key === key ? this.reconcileMemo.result : undefined;
    if (!result) {
      result = await reconcile({ repo: this.repo, state, marker, bootstrapRef });
      this.reconcileMemo = { key, result };
      for (const alert of result.alerts) this.opts.onWarning?.(alert);
    }
    const invalidRollback = result.alerts.find((alert) => /invalid rollback relationship|duplicate Vex-Rollback/i.test(alert));
    if (invalidRollback) throw new WikiIntegrityError(`${invalidRollback}; preserving repository and state`);
    return result;
  }

  private async checkIntegrity(): Promise<void> {
    try {
      validateSubtreeRoot(this.roots.wiki);
      validateSubtreeRoot(this.roots.raw);
      await this.repo.assertRollbackExpectations();
      await this.validateCommittedMarker();
      const observation = await observeWiki(this.repo);
      await assertRecognizedLocalHistory(this.repo, observation);
    } catch (error) {
      this.opts.onWarning?.(`wiki integrity check blocked an automatic action: ${(error as Error).message}`);
      if (error instanceof WikiIntegrityError) throw error;
      throw new WikiIntegrityError((error as Error).message);
    }
  }

  private async validateCommittedMarker(): Promise<void> {
    const marker = await this.marker.read();
    if (!marker) return;
    const fields = (await this.repo.log("HEAD")).split("\0");
    const matches: Array<{ sha: string; body: string }> = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const sha = (fields[index] ?? "").trim();
      const body = fields[index + 1] ?? "";
      const trailers = parseTrailers(body);
      const ids = trailerValues(trailers, "vex-batch");
      if (ids.includes(marker.batchId)) matches.push({ sha, body });
    }
    if (matches.length === 0 && marker.phase === "writing") return;
    if (matches.length !== 1) throw new WikiIntegrityError(`in-flight batch ${marker.batchId} has an ambiguous commit; preserving marker`);
    const commit = matches[0]!;
    const trailers = parseTrailers(commit.body);
    const kind = trailerValues(trailers, "vex-kind");
    const scanBase = trailerValues(trailers, "vex-scan-base");
    const expectedScanBase = marker.scanBase ?? "none";
    if (kind.length !== 1 || kind[0] !== marker.kind || scanBase.length !== 1 || scanBase[0] !== expectedScanBase) {
      throw new WikiIntegrityError(`in-flight batch ${marker.batchId} metadata does not match its commit`);
    }
    const touched = new Map(marker.touched.map((entry) => [entry.path, entry]));
    if (touched.size !== marker.touched.length || marker.touched.some((entry) => !entry.after)) throw new WikiIntegrityError(`in-flight batch ${marker.batchId} has incomplete or duplicate fingerprints`);
    const changed = await this.repo.changedPaths(commit.sha);
    if (changed.some((path) => !touched.has(path))) throw new WikiIntegrityError(`in-flight batch ${marker.batchId} commit changed an unowned path`);
    for (const entry of marker.touched) {
      const after = entry.after!;
      const expected = entry.expectedBefore.type === after.type && entry.expectedBefore.hash === after.hash ? entry.expectedBefore : after;
      const actual = await this.repo.fingerprintAt(commit.sha, entry.path);
      if (actual.type !== expected.type || actual.hash !== expected.hash) throw new WikiIntegrityError(`in-flight batch ${marker.batchId} commit content does not match ${entry.path}; preserving marker`);
    }
  }
}
