import { afterEach, expect, it, vi } from "vitest";
import { ApprovalManager } from "../src/policy/approvals.js";
import { formatApprovalPrompt } from "../src/channels/wechat/messages.js";
import { WikiPreviewReview } from "../src/wiki/review.js";

const preview = { batchId: "batch", commit: "abcdef1234567890", pages: ["wiki/index.md", "wiki/network.md"] };
afterEach(() => vi.useRealTimers());
function setup() {
  const approvals = new ApprovalManager({ timeoutMs: 100 });
  const wiki = {
    status: vi.fn().mockResolvedValue({ bootstrap: "awaiting-review", lastBatchId: "batch" }),
    approveBootstrap: vi.fn().mockResolvedValue({ pushed: true, message: "ok" }),
    rejectBootstrap: vi.fn().mockResolvedValue({ discarded: true, message: "ok" }),
  };
  const notify = vi.fn().mockResolvedValue(undefined);
  const warn = vi.fn();
  const review = new WikiPreviewReview({ approvals, wiki, notify, warn });
  return { approvals, wiki, notify, review, warn };
}
it("offers one actionable approval for a preview and publishes only after approval", async () => {
  const s = setup();
  s.review.offer(preview);
  s.review.offer(preview);
  expect(s.approvals.pending()).toHaveLength(1);
  expect(s.wiki.approveBootstrap).not.toHaveBeenCalled();
  const request = s.approvals.pending()[0]!;
  const text = formatApprovalPrompt(request, 1, "Asia/Hong_Kong");
  expect(text).toContain("[Approval needed]");
  expect(text).toContain("2 files");
  expect(text).toContain("abcdef123456");
  expect(text).toContain("wiki/network.md");
  expect(text).toContain("/y to approve and push");
  expect(text).toContain("/n to reject and discard");
  expect(text).not.toContain("/ya");
  s.approvals.answer(request.id, "allow");
  await vi.waitFor(() => expect(s.notify).toHaveBeenCalled());
  expect(s.wiki.approveBootstrap).toHaveBeenCalledTimes(1);
  expect(s.wiki.rejectBootstrap).not.toHaveBeenCalled();
  await s.review.close();
});
it("discards only after an explicit rejection", async () => {
  const s = setup();
  s.review.offer(preview);
  s.approvals.answer(s.approvals.pending()[0]!.id, "deny");
  await vi.waitFor(() => expect(s.notify).toHaveBeenCalled());
  expect(s.wiki.rejectBootstrap).toHaveBeenCalledTimes(1);
  expect(s.wiki.approveBootstrap).not.toHaveBeenCalled();
  await s.review.close();
});
it("retains preview on approval timeout", async () => {
  vi.useFakeTimers();
  const s = setup();
  s.review.offer(preview);
  await vi.advanceTimersByTimeAsync(101);
  expect(s.notify).toHaveBeenCalledWith(expect.stringContaining("preview is kept"));
  expect(s.wiki.rejectBootstrap).not.toHaveBeenCalled();
  expect(s.wiki.approveBootstrap).not.toHaveBeenCalled();
  await s.review.close();
});
it("retains preview when shutting down", async () => {
  const s = setup();
  s.review.offer(preview);
  await s.review.close();
  expect(s.approvals.pending()).toHaveLength(0);
  expect(s.notify).not.toHaveBeenCalled();
  expect(s.wiki.rejectBootstrap).not.toHaveBeenCalled();
  expect(s.wiki.approveBootstrap).not.toHaveBeenCalled();
});
it("does not apply an old approval to a different preview", async () => {
  const s = setup();
  s.review.offer(preview);
  s.wiki.status.mockResolvedValue({ bootstrap: "awaiting-review", lastBatchId: "new-batch" });
  s.approvals.answer(s.approvals.pending()[0]!.id, "allow");
  await vi.waitFor(() => expect(s.notify).toHaveBeenCalled());
  expect(s.wiki.approveBootstrap).not.toHaveBeenCalled();
  expect(s.wiki.rejectBootstrap).not.toHaveBeenCalled();
  await s.review.close();
});
