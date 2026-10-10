import type { VaultConfig, WikiConfig } from "../config/schema.js";
import type { ApprovalManager } from "../policy/approvals.js";
import type { GitRunner } from "./git.js";
import { WikiPreviewReview } from "./review.js";
import { Wiki, type WikiOptions } from "./service.js";

export interface WikiRuntimeOptions {
  home: string;
  vault: VaultConfig & { url: string };
  config: WikiConfig;
  approvals: ApprovalManager;
  /** Queues an owner notification; it must not wait for the owner's session to go idle. */
  notify: (text: string) => Promise<void>;
  runAgent: WikiOptions["runAgent"];
  sourceSegmentBudget?: WikiOptions["sourceSegmentBudget"];
  run?: GitRunner;
  warn: (error: unknown) => void;
  onWarning?: (message: string) => void;
}

/**
 * The daemon-facing wiki: the Wiki service plus, when notifications are on, the owner review of
 * its bootstrap preview. `start` opens the writable clone; close the review before the service.
 */
export class WikiRuntime {
  private constructor(readonly wiki: Wiki, private readonly review: WikiPreviewReview | undefined) {}

  static async start(opts: WikiRuntimeOptions): Promise<WikiRuntime> {
    let review: WikiPreviewReview | undefined;
    const wiki = new Wiki({
      home: opts.home,
      vault: opts.vault,
      branch: opts.vault.branch,
      maxNotesPerRun: opts.config.maxNotesPerRun,
      notifyEnabled: opts.config.notify,
      ...(opts.run ? { run: opts.run } : {}),
      ...(opts.config.notify ? { requestPreviewReview: (preview) => review?.offer(preview) } : {}),
      notify: opts.notify,
      runAgent: opts.runAgent,
      ...(opts.sourceSegmentBudget ? { sourceSegmentBudget: opts.sourceSegmentBudget } : {}),
      ...(opts.onWarning ? { onWarning: opts.onWarning } : {}),
    });
    if (opts.config.notify) review = new WikiPreviewReview({ approvals: opts.approvals, wiki, notify: opts.notify, warn: opts.warn });
    try { await wiki.init(); }
    catch (error) { await review?.close(); throw error; }
    return new WikiRuntime(wiki, review);
  }

  /** The writable working copy, which general file tools must not touch. */
  get root(): string { return this.wiki.root; }

  /** Asks the owner again about a bootstrap preview left unpublished by an earlier process. */
  async offerPendingPreview(): Promise<void> {
    if (!this.review) return;
    const preview = await this.wiki.preview();
    if (preview) this.review.offer(preview);
  }

  closeReview(): Promise<void> { return this.review?.close() ?? Promise.resolve(); }

  close(): Promise<void> { return this.wiki.close(); }
}
