import type { VaultConfig, WikiConfig } from "../config/schema.js";
import type { GitRunner } from "./git.js";
import { previewNotice, Wiki, type WikiOptions } from "./service.js";

export interface WikiRuntimeOptions {
  home: string;
  vault: VaultConfig & { url: string };
  config: WikiConfig;
  /** Queues an owner notification; it must not wait for the owner's session to go idle. */
  notify: (text: string) => Promise<void>;
  runAgent: WikiOptions["runAgent"];
  sourceSegmentBudget?: WikiOptions["sourceSegmentBudget"];
  run?: GitRunner;
  onWarning?: (message: string) => void;
}

/**
 * The daemon-facing wiki. Publishing a bootstrap preview has one entry, the `wiki_bootstrap` tool
 * behind its `ask` policy; the runtime only tells the owner that a preview is waiting.
 */
export class WikiRuntime {
  private constructor(readonly wiki: Wiki, private readonly opts: WikiRuntimeOptions) {}

  static async start(opts: WikiRuntimeOptions): Promise<WikiRuntime> {
    const wiki = new Wiki({
      home: opts.home,
      vault: opts.vault,
      branch: opts.vault.branch,
      maxNotesPerRun: opts.config.maxNotesPerRun,
      notifyEnabled: opts.config.notify,
      ...(opts.run ? { run: opts.run } : {}),
      notify: opts.notify,
      runAgent: opts.runAgent,
      ...(opts.sourceSegmentBudget ? { sourceSegmentBudget: opts.sourceSegmentBudget } : {}),
      ...(opts.onWarning ? { onWarning: opts.onWarning } : {}),
    });
    await wiki.init();
    return new WikiRuntime(wiki, opts);
  }

  /** The writable working copy, which general file tools must not touch. */
  get root(): string { return this.wiki.root; }

  /** Reminds the owner of a bootstrap preview left unpublished by an earlier process. */
  async remindPendingPreview(): Promise<void> {
    if (!this.opts.config.notify) return;
    const preview = await this.wiki.preview();
    if (preview) await this.opts.notify(previewNotice(preview));
  }

  close(): Promise<void> { return this.wiki.close(); }
}
