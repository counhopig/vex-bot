import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { VaultConfig } from "../../config/schema.js";
import { abortBatch, assertBatchOwnership, assertSafeTouchedPath, ingestMessage, ingestPrompt, inspectAndCleanTree } from "./batch.js";
import { chunk, detectChanges, type Change } from "./changes.js";
import { parseTrailers, WikiIntegrityError, WikiRepo, type GitRunner } from "./git.js";
import { assertRecognizedLocalHistory, observeWiki } from "./integrity.js";
import { fingerprint, MarkerStore } from "./marker.js";
import { validateSubtreeRoot, validateSubtreeRoots, wikiRawPath } from "./paths.js";
import { reconcile, type ReconcileResult } from "./reconcile.js";
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

const OPEN_RETRY_MS = 60_000;

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

export interface WikiStatus { bootstrap: WikiBootstrapStatus; nextAttemptAt: number | null; lastBatchId: string | null }

function statusOf(state: WikiState | null, reconciled: ReconcileResult): WikiStatus {
  // `awaiting-review` means an unpublished bootstrap preview specifically; an unpublished
  // scheduled/on-demand batch is left alone so the cadence can retry its push.
  const bootstrap: WikiBootstrapStatus = reconciled.preview
    ? "awaiting-review"
    : reconciled.bootstrap === "done"
      ? "done"
      : "pending";
  return { bootstrap, nextAttemptAt: state?.nextAttemptAt ?? null, lastBatchId: reconciled.lastBatchId };
}

/**
 * Which wiki work the scheduler may start: a pending bootstrap once the backoff gate opens, or a
 * scheduled run once both the gate and the cadence allow it. Nothing runs while a preview awaits review.
 */
export function dueWikiWork(input: { bootstrap: WikiBootstrapStatus; gate: number | null; now: number; cadenceDue: boolean }): "bootstrap" | "scheduled" | null {
  if (input.now < (input.gate ?? 0)) return null;
  if (input.bootstrap === "pending") return "bootstrap";
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
    const { bootstrap } = await this.status();
    return dueWikiWork({ bootstrap, gate, now, cadenceDue });
  }

  async status(): Promise<WikiStatus> {
    // `status()` is polled every scheduler tick; cache briefly so an idle wiki does no history scans.
    if (this.statusCache && Date.now() - this.statusCache.at < 10_000) return this.statusCache.value;
    await this.ready();
    // A running operation may be mid-rebase; report the last settled status instead of reading history.
    if (this.lock.busy && this.lastStatus) return this.lastStatus;
    const state = await this.stateStore.read();
    const reconciled = await this.runReconcile(state);
    this.reconciled = reconciled;
    this.cachedNextAttemptAt = state?.nextAttemptAt ?? null;
    const value = statusOf(state, reconciled);
    this.lastStatus = value;
    this.statusCache = { at: Date.now(), value };
    return value;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.reconciled = null;
    this.statusCache = null;
  }

  async run(
    kind: { kind: "scheduled" | "bootstrap" | "on-demand"; source?: { title?: string; url?: string; canonicalUrl?: string; text?: string; truncated?: boolean; textKind?: string; metadataOnly?: boolean } },
    signal: AbortSignal,
  ): Promise<WikiRunResult> {
    if (kind.kind === "on-demand" && kind.source?.url && !kind.source.text?.trim()) {
      return { batchId: null, commit: null, pages: [], publication: "not-needed" };
    }
    await this.ready();
    return this.lock.run(async () => {
      try {
      await this.repo.fetch();
      const state = await this.stateStore.read();
      const reconciled = await this.runReconcile(state);
      this.reconciled = reconciled;
      const pendingCompile = reconciled.markerResolution === "committed" ? await this.marker.read() : null;

      // Refuse before recovery cleanup can restore or remove any paths.
      await this.checkIntegrity();

      const advancesScan = kind.kind !== "on-demand";
      let baseHead = "";
      let batchId = "";

      if (reconciled.preview) throw new Error("bootstrap preview awaiting review");

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
            lastRunAt: Date.now(),
          });
          await this.marker.remove();
          this.cachedNextAttemptAt = null;
          this.statusCache = null;
          const settledPages = (await this.repo.changedPaths(settledSha)).filter((path) => path.startsWith("wiki/"));
          const sameSource = kind.kind === "on-demand" && kind.source?.url && pendingCompile.touched.some((entry) => entry.path === this.sourcePath(kind.source!.url!));
          if (sameSource) {
            const pendingSource = pendingCompile.touched.find((entry) => entry.path === this.sourcePath(kind.source!.url!));
            const expectedContent = ["---", `title: ${JSON.stringify(kind.source!.title ?? kind.source!.url)}`, `url: ${JSON.stringify(kind.source!.url)}`, ...(kind.source!.canonicalUrl ? [`canonical_url: ${JSON.stringify(kind.source!.canonicalUrl)}`] : []), "---", "", kind.source!.text ?? "", ""].join("\n");
            const expectedHash = createHash("sha256").update(expectedContent).digest("hex");
            if (pendingSource?.after?.hash === expectedHash) return { batchId: pendingCompile.batchId, commit: settledSha, pages: settledPages, publication: "published" };
          }
        }
        if (!pendingCompile && !(await this.repo.isAncestor(await this.repo.head(), await this.repo.originHead()))) await this.repo.push();
        baseHead = await this.repo.head();
      } catch (error) {
        if (pendingCompile) {
          try { await this.recordFailure(); } catch { /* keep the committed marker and return its receipt */ }
          const pendingSha = pendingCompile.commit ?? await this.findCommit("Vex-Batch", pendingCompile.batchId).catch(() => null);
          const pendingPages = pendingSha ? (await this.repo.changedPaths(pendingSha)).filter((path) => path.startsWith("wiki/")) : [];
          return { batchId: pendingCompile.batchId, commit: pendingSha, pages: pendingPages, publication: "pending" };
        }
        if (error instanceof WikiIntegrityError) throw error;
        await abortBatch(this.repo, this.marker);
        throw error;
      }

      // A compile run ingests every note added since the last scan, splitting them across as
      // many agent calls as `maxNotesPerRun` allows. On-demand runs skip detection entirely.
      const cursor = reconciled.lastScanCommit ?? null;
      const from = cursor !== null && !(await this.repo.isAncestor(cursor, await this.repo.head())) ? null : cursor;
      if (kind.kind !== "on-demand") {
        const changes = await detectChanges(this.repo, from);
        if (changes.length === 0) {
          const current = (await this.stateStore.read()) ?? emptyState();
          await this.stateStore.write({ ...current, lastScanCommit: advancesScan ? baseHead : current.lastScanCommit, failureStreak: 0, nextAttemptAt: null, ...(kind.kind === "bootstrap" ? { bootstrap: "done" as const } : {}) });
          if (kind.kind === "bootstrap") await this.repo.updateRef("refs/vex/wiki-bootstrap", baseHead);
          this.cachedNextAttemptAt = null;
          this.statusCache = null;
          return { batchId: null, commit: null, pages: [], publication: "not-needed" };
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
            await this.opts.runAgent(this.chunkPrompt(part), { repo: this.repo, marker: this.marker, roots: this.roots }, signal);
          }
        } catch (error) {
          await abortBatch(this.repo, this.marker);
          throw error;
        }
      } else {
        batchId = randomUUID();
        try {
          const body = kind.source?.text ?? "";
          let sourceSegmentLimit = 12_000;
          if (kind.source?.url && body && this.opts.sourceSegmentBudget) {
            const prefix = this.sourcePrompt(kind, "", 999, 999);
            sourceSegmentLimit = Math.max(1, Math.min(sourceSegmentLimit, await this.opts.sourceSegmentBudget(prefix, { repo: this.repo, marker: this.marker, roots: this.roots })));
          }
          const segments = kind.source?.url && body ? splitSource(body, sourceSegmentLimit) : [body];
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
          if (kind.source?.url && kind.source.text !== undefined && kind.source.text.trim()) {
            if (kind.source.truncated) throw new Error("The retrieved source is truncated and cannot be archived as a complete original.");
            signal.throwIfAborted();
            const path = this.sourcePath(kind.source.url);
            const content = ["---", `title: ${JSON.stringify(kind.source.title ?? kind.source.url)}`, `url: ${JSON.stringify(kind.source.url)}`, ...(kind.source.canonicalUrl ? [`canonical_url: ${JSON.stringify(kind.source.canonicalUrl)}`] : []), "---", "", kind.source.text, ""].join("\n");
            const current = await fingerprint(join(this.repo.root, path));
            const hash = createHash("sha256").update(content).digest("hex");
            if (current.type !== "file" || current.hash !== hash) {
              await writeWikiFile({ repo: this.repo, marker: this.marker, roots: this.roots }, path, content);
            }
          }
          for (let index = 0; index < segments.length; index++) {
            signal.throwIfAborted();
            await this.opts.runAgent(this.sourcePrompt(kind, segments[index] ?? "", index + 1, segments.length), { repo: this.repo, marker: this.marker, roots: this.roots }, signal);
          }
        } catch (error) {
          await abortBatch(this.repo, this.marker);
          throw error;
        }
      }

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
        const current = (await this.stateStore.read()) ?? emptyState();
        await this.stateStore.write({ ...current, lastScanCommit: advancesScan ? baseHead : current.lastScanCommit, failureStreak: 0, nextAttemptAt: null, ...(kind.kind === "bootstrap" ? { bootstrap: "done" as const } : {}) });
        if (kind.kind === "bootstrap") await this.repo.updateRef("refs/vex/wiki-bootstrap", baseHead);
        this.cachedNextAttemptAt = null;
        this.statusCache = null;
        await this.marker.remove();
        return { batchId, commit: null, pages: [], publication: "not-needed" };
      }

      let sha = "";
      let committedPages: string[] = [];
      let committedRawPaths: string[] = [];
      try {
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
        if (changedTouched.length === 0) {
          const before = new Map(await Promise.all(touched.map(async (entry) => [entry.path, await this.repo.fingerprintAt(baseHead, entry.path)] as const)));
          const after = new Map(touched.map((entry) => [entry.path, entry.after!]));
          await this.repo.assertIndexFingerprints(before, after);
          const current = (await this.stateStore.read()) ?? emptyState();
          await this.stateStore.write({
            ...current,
            lastScanCommit: advancesScan ? baseHead : current.lastScanCommit,
            failureStreak: 0,
            nextAttemptAt: null,
            ...(kind.kind === "bootstrap" ? { bootstrap: "done" as const } : {}),
          });
          if (kind.kind === "bootstrap") await this.repo.updateRef("refs/vex/wiki-bootstrap", baseHead);
          this.cachedNextAttemptAt = null;
          this.statusCache = null;
          await this.marker.remove();
          return { batchId, commit: null, pages: [], publication: "not-needed" };
        }
        sha = await this.repo.commit(
          changedTouched.map((entry) => entry.path),
          ingestMessage(kind.kind, batchId, scanBase, changedTouched.length, new Date()),
          new Map(changedTouched.map((entry) => [entry.path, entry.after!])),
          new Map(await Promise.all(changedTouched.map(async (entry) => [entry.path, await this.repo.fingerprintAt(baseHead, entry.path)] as const))),
        );
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
        committedPages = committedPaths.filter((path) => path.startsWith("wiki/"));
        committedRawPaths = committedPaths.filter((path) => path.startsWith("raw/"));
      } catch (error) {
        const integrityFailure = error instanceof WikiIntegrityError;
        const state = await this.stateStore.read();
        const recovered = await this.runReconcile(state);
        if (recovered.markerResolution === "committed") {
          const recoveredBatch = await this.marker.read();
          const recoveredSha = recoveredBatch?.batchId === batchId ? await this.findCommit("Vex-Batch", batchId) : null;
          if (recoveredBatch?.batchId === batchId && recoveredSha) {
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
            if (this.opts.notifyEnabled) await this.opts.notify(wikiOutcomeText(recoveredRaw, recoveredPages, "pending")).catch(() => undefined);
            return { batchId, commit: recoveredSha, pages: recoveredPages, publication: "pending" };
          }
        } else if (!integrityFailure) {
          await abortBatch(this.repo, this.marker);
        }
        throw error;
      }
      try {
        await this.marker.setCommitted(sha);
      } catch {
        try { await this.recordFailure(); } catch { /* the writing marker and commit trailer remain sufficient for recovery */ }
        this.statusCache = null;
        if (this.opts.notifyEnabled) await this.opts.notify(wikiOutcomeText(committedRawPaths, committedPages, "pending")).catch(() => undefined);
        return { batchId, commit: sha, pages: committedPages, publication: "pending" };
      }

      let pushed = false;
      try {
        if (kind.kind !== "bootstrap") {
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
          lastRunAt: Date.now(),
        });
        await this.marker.remove();
      } catch (error) {
        if (this.opts.notifyEnabled) await this.opts.notify(wikiOutcomeText(committedRawPaths, committedPages, "pending")).catch(() => undefined);
        try { await this.recordFailure(); } catch { /* the committed marker remains the durable recovery record */ }
        this.statusCache = null;
        return { batchId, commit: sha, pages: committedPages, publication: "pending" };
      }

      if (this.opts.notifyEnabled) {
        await this.opts.notify(kind.kind === "bootstrap"
          ? previewNotice({ batchId, commit: sha, pages: committedPages })
          : wikiOutcomeText(committedRawPaths, committedPages, pushed ? "published" : "pending")).catch(() => undefined);
      }
      this.cachedNextAttemptAt = null;
      this.statusCache = null;
      return { batchId, commit: sha, pages: committedPages, publication: kind.kind === "bootstrap" ? "preview" : pushed ? "published" : "pending" };
      } catch (error) {
        const failureStreak = await this.recordFailure();
        // A run of consecutive failures is reported once, when it starts.
        if (this.opts.notifyEnabled && failureStreak === 1) await this.opts.notify(`wiki: run failed: ${(error as Error).message}`).catch(() => undefined);
        throw error;
      }
    }, signal);
  }

  /** Records a failed run and the exponential backoff that gates the next attempt; returns the consecutive failure count. */
  private async recordFailure(): Promise<number> {
    const current = (await this.stateStore.read()) ?? emptyState();
    const failureStreak = current.failureStreak + 1;
    const backoff = Math.min(60 * 60_000, 5 * 60_000 * 2 ** (failureStreak - 1));
    const nextAttemptAt = Date.now() + backoff;
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
      await this.stateStore.write({ ...current, bootstrap: "done", lastRunAt: Date.now() });
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
      await this.stateStore.write({ ...current, lastBatchId: null, rollback: null, bootstrap: "pending" });
      return { discarded: true, message: "bootstrap preview discarded" };
    }, signal);
  }

  private sourcePath(url: string): string {
    return wikiRawPath(url);
  }

  /** The one-shot prompt for an on-demand run, carrying the requesting source when present. */
  private sourcePrompt(kind: {
    kind: "scheduled" | "bootstrap" | "on-demand";
    source?: { title?: string; url?: string; canonicalUrl?: string; text?: string; truncated?: boolean; textKind?: string; metadataOnly?: boolean };
  }, segment: string, segmentIndex: number, segmentCount: number): string {
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
      const found = Object.keys(trailers).some((key) => key.toLowerCase() === trailer.toLowerCase() && trailers[key]?.includes(value));
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
      const targetIds = Object.entries(trailers).find(([key]) => key.toLowerCase() === "vex-revert-of")?.[1] ?? [];
      if (targetIds.length !== 1 || targetIds[0] !== state.rollback.targetBatchId) throw new WikiIntegrityError("pending rollback target does not match its commit; preserving state");
      if (!(await this.repo.isAncestor(stateCommit, await this.repo.originHead()))) throw new WikiIntegrityError("pending rollback is not the reconciled history tip; preserving state");
      await this.clearBatchRef();
      return;
    }
    const rollbackCommit = await this.findCommit("Vex-Rollback", pending.revertId);
    if (!rollbackCommit) throw new WikiIntegrityError("pending rollback commit is missing; preserving state");
    const trailers = parseTrailers((await this.repo.log(rollbackCommit)).split("\0")[1] ?? "");
    const targetIds = Object.entries(trailers).find(([key]) => key.toLowerCase() === "vex-revert-of")?.[1] ?? [];
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
    const kinds = Object.entries(trailers).find(([key]) => key.toLowerCase() === "vex-kind")?.[1] ?? [];
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
    const bootstrapRef = await this.repo.ref("refs/vex/wiki-bootstrap");
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
      const ids = Object.entries(trailers).find(([key]) => key.toLowerCase() === "vex-batch")?.[1] ?? [];
      if (ids.includes(marker.batchId)) matches.push({ sha, body });
    }
    if (matches.length === 0 && marker.phase === "writing") return;
    if (matches.length !== 1) throw new WikiIntegrityError(`in-flight batch ${marker.batchId} has an ambiguous commit; preserving marker`);
    const commit = matches[0]!;
    const trailers = parseTrailers(commit.body);
    const kind = Object.entries(trailers).find(([key]) => key.toLowerCase() === "vex-kind")?.[1] ?? [];
    const scanBase = Object.entries(trailers).find(([key]) => key.toLowerCase() === "vex-scan-base")?.[1] ?? [];
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
