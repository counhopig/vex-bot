import type { ApprovalAnswer, ApprovalManager } from "../policy/approvals.js";
import type { Wiki, WikiPreview } from "./service.js";

export class WikiPreviewReview {
  private readonly abort = new AbortController();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly opts: {
    approvals: ApprovalManager;
    wiki: Pick<Wiki, "status" | "approveBootstrap" | "rejectBootstrap">;
    notify: (text: string) => Promise<void>;
    warn: (error: unknown) => void;
  }) {}

  offer(preview: WikiPreview): void {
    if (this.abort.signal.aborted || this.pending.has(preview.batchId)) return;
    const task = this.review(preview).catch(this.opts.warn).finally(() => this.pending.delete(preview.batchId));
    this.pending.set(preview.batchId, task);
  }

  async close(): Promise<void> {
    this.abort.abort();
    await Promise.all(this.pending.values());
  }

  private async review(preview: WikiPreview): Promise<void> {
    let answer: ApprovalAnswer | undefined;
    const outcome = await this.opts.approvals.request({
      sessionKey: `wiki-preview:${preview.batchId}`,
      windowLabel: "Wiki bootstrap",
      toolName: "wiki_bootstrap",
      args: { action: "approve", commit: preview.commit, pages: preview.pages },
      signal: this.abort.signal,
      onAnswer: (value) => { answer = value; },
    });
    if (this.abort.signal.aborted) return;
    if (answer === undefined) {
      await this.opts.notify("Wiki approval timed out. The preview is kept and has not been pushed. Say \"approve the Wiki preview\" or \"reject the Wiki preview\" to continue.");
      return;
    }
    const status = await this.opts.wiki.status();
    if (status.bootstrap !== "awaiting-review" || status.lastBatchId !== preview.batchId) {
      await this.opts.notify("This Wiki preview is no longer awaiting review. This answer did not push or discard anything.");
      return;
    }
    if (outcome.allowed) {
      const result = await this.opts.wiki.approveBootstrap(this.abort.signal);
      await this.opts.notify(result.pushed ? "Wiki bootstrap preview approved and pushed to the notes repository. Future compilations will commit and push automatically." : `Wiki preview was not pushed: ${result.message}`);
    } else {
      const result = await this.opts.wiki.rejectBootstrap(this.abort.signal);
      await this.opts.notify(result.discarded ? "Wiki bootstrap preview rejected and discarded locally without pushing. The next bootstrap compilation will still require approval." : `Wiki preview was not discarded: ${result.message}`);
    }
  }
}

export function blockPendingWikiBootstrapReview(approvals: Pick<ApprovalManager, "pending">, toolName: string): { block: true; reason: string } | undefined {
  if (toolName !== "wiki_bootstrap" || !approvals.pending().some((request) => request.toolName === "wiki_bootstrap" && request.windowLabel === "Wiki bootstrap")) return undefined;
  return { block: true, reason: "A Wiki bootstrap preview is already awaiting its existing owner approval. Wait for the owner to answer that prompt; do not call wiki_bootstrap." };
}
