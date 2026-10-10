import type { NotesCopy } from "../notes.js";
import type { WikiRepo } from "./git.js";
import type { WikiLock } from "./lock.js";
import type { MarkerStore } from "./marker.js";

const READ_SYNC_MS = 60_000;

export interface WikiReadCopyOptions {
  lock: WikiLock;
  /** The opened clone and its batch marker; undefined until the wiki has opened the clone. */
  open: () => { repo: WikiRepo; marker: MarkerStore } | undefined;
  /** Called after HEAD moved, so cached wiki status is recomputed. */
  onAdvanced: () => void;
  now?: () => number;
  onWarning?: (message: string) => void;
}

/**
 * The wiki's clone as the vault reads it. With the wiki on, the vault has no separate mirror: this
 * copy fast-forwards the clone at most once a minute, and only while no wiki operation holds or
 * waits for the lock, no batch is in flight and the tree is clean. Unpublished local commits stay.
 */
export class WikiReadCopy implements NotesCopy {
  private sync: { at: number; error?: string } | null = null;

  constructor(private readonly opts: WikiReadCopyOptions) {}

  async readableCopy(): Promise<{ root: string; source: string }> {
    const opened = this.opts.open();
    if (!opened) throw new Error("The notes vault is still opening; try again shortly.");
    const now = (this.opts.now ?? Date.now)();
    if (!this.opts.lock.busy && (this.sync === null || now - this.sync.at >= READ_SYNC_MS)) {
      try {
        await this.opts.lock.run(() => this.fastForward(opened.repo, opened.marker));
        this.sync = { at: now };
      } catch (error) {
        const message = (error as Error).message;
        this.sync = { at: now, error: message };
        this.opts.onWarning?.(`The notes vault could not be updated: ${message}`);
      }
    }
    const sync = this.sync;
    const source = sync === null ? "git copy; a wiki run is updating it"
      : sync.error ? `git copy; the latest sync failed: ${sync.error}`
        : `git copy synced ${new Date(sync.at).toISOString()}`;
    return { root: opened.repo.root, source };
  }

  private async fastForward(repo: WikiRepo, marker: MarkerStore): Promise<void> {
    await repo.fetch();
    if (await marker.read() || (await repo.statusEntries()).length > 0) return;
    if (await repo.fastForward()) this.opts.onAdvanced();
  }
}
