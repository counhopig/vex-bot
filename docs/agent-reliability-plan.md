# Agent reliability repair plan

## Objective and scope

An owner request must produce a verifiable execution outcome across intent classification, tool execution, permissions, Wiki transactions, and message delivery. Sharing a readable link archives its original content and compiles the Wiki once bootstrap is approved, unless the owner explicitly opts out. Successful reading remains distinguishable from successful compilation and publication.

Repair the existing Agent construction and its integration boundaries. Keep the current WeChat/WebChat interfaces, Jev settings, tool permissions, bootstrap review, supported link platforms, and Wiki working copy. Use existing dependencies. Product prompts, tool descriptions, and documentation are English; conversational responses follow the owner's language.

This plan does not introduce an OS sandbox, a general workflow engine, a durable notification service, new settings pages, or additional link platforms. The automatic-writer boundary remains the existing X contract: owner-approved shell/MCP operations can write concurrently; integrity checks detect attributable changes at checkpoints but cannot eliminate check-to-operation races.

The implementation starts from the current working tree, including its uncommitted changes. Preserve unrelated changes. Planning authorizes no production deployment, real-vault test pushes, or deletion of owner data. All automated Git tests use temporary local bare repositories.

## Execution contract

```text
Owner message
  -> request identity and outstanding actions
  -> intent classification
  -> bounded runtime action or ordinary model tool selection
  -> pi tool execution and the existing approval gate
  -> structured tool outcome
  -> grounded response and asynchronous notification
```

For a shared-link archival action, the runtime submits the existing `wiki_ingest` tool with a URL. The tool retrieves the original through the programmatic link reader and invokes the existing Wiki transaction. It returns the retrieved source and publication receipt to the model. Neither generating tool arguments containing copied article text nor remembering an ingestion instruction is required of the main model.

The runtime submits actions as ordinary pi tool calls, with unique call IDs, no pre-execution success text, and zero provider usage for runtime-generated messages. Calls pass through schema validation, policy, approvals, tool events, and transcript persistence. The runtime never calls a tool's `execute` method directly to bypass the gate.

General Jev tool suggestions remain advisory: the model supplies arguments. Fixed shared-link actions have a bounded executor. No repeated prompt correction is used to enforce completion of these actions.

## Required invariants

1. A tool or Wiki transaction never waits for the caller's Session to become idle to report its result.
2. Wiki publication includes only attributable generated changes and recognized unpublished Wiki commits. Normal remote advancement is accepted; unexplained local changes are preserved and block automatic mutation/publication.
3. Preview rejection/reset requires refreshed remote evidence, a clean tree/index, the expected preview identity, and an unpublished local tip. Refusal leaves HEAD, files, and state unchanged.
4. Only a writing-phase transaction with matching fingerprints can restore files. A commit discovered in history takes precedence over a stale writing marker. Committed work is retained for settlement.
5. Read, compile, commit, and push are separate outcomes. A failed push after a successful commit retains its receipt and is not reported as a failed read.
6. A proposed operation claim is checked against matching results, regardless of whether its assistant message also contains tool calls. Child-agent narration is not execution evidence.
7. Outstanding actions belong to owner requests, survive steering and context projection within the active run, and execute at most once per action in that run. Unrelated tool results do not complete them.
8. Every provider request fits its input/output reservation after prompt construction, tool declarations, compaction, and routing instructions. An unfit current request is rejected locally without provider retries.

## Shared interfaces

Add small typed contracts where existing modules exchange unstructured strings:

```ts
// src/core/execution.ts
interface RequestAction {
  id: string;
  requestId: string;
  url: string;
  shareText: string;
  intent: "read" | "archive" | "defer";
  state: "pending" | "running" | "completed" | "blocked" | "cancelled";
}

// src/links/source.ts
interface OriginalSource {
  requestedUrl: string;
  canonicalUrl: string;
  title: string;
  text: string;
  textKind: "text" | "article" | "subtitles" | "transcript";
  truncated: boolean;
}

// src/wiki/service.ts
interface WikiRunResult {
  batchId: string | null;
  commit: string | null;
  pages: string[];
  publication: "not-needed" | "preview" | "published" | "pending";
}
```

`wiki_ingest` results include a versioned, JSON-compatible receipt with requested/canonical URL, source availability, raw path, Wiki batch/commit, publication state, and a bounded source excerpt. Serialize the receipt in tool-result text content for the model and mirror it under `details.receipt` for runtime validation and transcript recovery. The installed pi loop preserves `details` in toolResult messages but does not copy `structuredContent` there; do not depend on that field for receipts. Keep large original bodies out of receipts and Jev requests.

Retrieval failures return a typed failed-read result and perform no Wiki mutation. A metadata-only link has no archival body and is reported explicitly. Pre-commit compilation failure keeps the existing atomic rollback behavior; post-commit settlement failure retains the commit and returns a pending-publication receipt. Cancellation propagates instead of becoming a retrieval failure.

Manual `wiki_ingest` calls containing text remain supported when no URL is present. When a URL is present, retrieve the original in the tool; model-supplied text is not accepted as proof of the original. A successful receipt never claims that Wiki pages changed merely because a raw file changed.

## Implementation sequence

Each task starts with a regression test for the required behavior, implements the owning interface, and runs its focused tests. Dependency order is explicit below. Commit selection must include only task-owned changes; do not stage the entire working tree.

### Task 1: Guard repository identity and unpublished history

**Files:** new `src/wiki/integrity.ts`, modify `src/wiki/git.ts`, `src/wiki/reconcile.ts`, `src/wiki/service.ts`; new `tests/wiki-integrity.test.ts`, extend `tests/wiki-service.test.ts` and `tests/wiki-reconcile.test.ts`.

Expose Git observations for origin fetch/push URLs, active branch, HEAD, refreshed remote tip, local-only commits, commit changes, and structured NUL-delimited status. Validate origin/branch against configured expectations before fetch and every publication/destructive checkpoint. Treat remote fast-forward changes as ordinary input, not unexplained local changes.

Classify local-only compile/rollback commits using unique, valid trailers and generated-path scope. Check actual commit contents, not just a clean working tree or the presence of `Vex-Batch`. Ambiguous/duplicate batch identities and invalid rollback relationships block automatic actions. A missing historical reference is handled explicitly without falling back to a stale state pointer.

Integrate the guard before rebase, settlement, push/retry, and reset. A force-push/divergent history that makes provenance or scan boundaries ambiguous is preserved and reported; never force-push to repair it. Surface reconciliation alerts through the existing warning path.

**Tests:** an unknown local commit is not pushed; a recognized pending batch can settle; a generated trailer on a commit changing an owner note is rejected; changed origin/push URL blocks publication; duplicate batch IDs block lookup; remote fast-forward succeeds; divergence remains intact. Assert remote SHA and local bytes, not only error strings.

### Task 2: Enforce transaction ownership at commit and cleanup

**Depends on:** Task 1.

**Files:** modify `src/wiki/batch.ts`, `src/wiki/tools.ts`, `src/wiki/git.ts`, `src/wiki/marker.ts`, `src/wiki/service.ts`, `src/wiki/paths.ts`; extend `tests/wiki-batch.test.ts`, `tests/wiki-tools.test.ts`, `tests/wiki-git.test.ts`, `tests/wiki-marker.test.ts`, `tests/wiki-service.test.ts`, and `tests/wiki-paths.test.ts`.

Use structured status/index observations to reject all changed or staged paths absent from the marker. Validate every touched path's recorded after fingerprint and current root/target safety immediately before staging. Revalidate real subtree roots at operation checkpoints; initialization alone is insufficient after remote or external changes.

Stage literal pathspecs, validate cached changes and blob contents against the batch, and create a path-limited commit (`git commit --only` with literal touched paths). Unrelated staged paths must not enter the commit even if they appear after the index check. Recheck the resulting commit before publication. Preserve the documented residual race for externally changing a selected file between checks and Git operations.

Cleanup requires a writing marker with matching after fingerprints. Validate attribution for every dirty path before restoring any paths. Retain unresolved markers and external files on ambiguous recovery. `abortBatch` refuses to restore committed work; history reconciliation handles commit-to-marker crashes first.

**Tests:** an unrelated note staged during compilation remains unchanged locally and absent remotely; unknown dirty paths within Wiki/raw block the run; touched files changed externally are preserved; filenames containing spaces/Unicode/pathspec characters stay literal; committed markers cannot trigger restoration; incomplete write intent preserves the file; a root redirected after init is rejected. Include A→B→C between writes and intent-write failure coverage.

### Task 3: Protect preview rejection and rollback

**Depends on:** Tasks 1–2.

**Files:** modify `src/wiki/service.ts`, `src/wiki/git.ts`, `src/wiki/reconcile.ts`; extend `tests/wiki-service.test.ts`, `tests/wiki-reconcile.test.ts`, and `tests/wiki-review.test.ts`.

Apply the same repository/tree/index integrity guards to preview approval, rejection, pending rollback settlement, and rollback. Re-fetch before publication decisions. Require the correct preview kind/identity and `HEAD === target` before discarding an unpublished preview. Dirty trees or ambiguous identities return a refusal without state changes.

A published target is never reset. A pending revert is completed once, using its stable rollback identity. Revert conflict recovery must not call unrestricted `reset --hard` over new external edits; abort only attributable Git operation state and preserve ambiguous changes.

**Tests:** owner edits made after preview generation survive reject/approve refusal; staged and untracked collisions are retained; a remotely published preview is recognized; a non-tip preview is retained; failed rollback push then retry produces one revert; commit-before-state and complete state loss recover from trailers. Preserve published scan progress after rollback.

### Task 4: Separate notification enqueue from delivery

**Depends on:** Tasks 1–3 for transaction fixtures.

**Files:** modify `src/core/session.ts`, `src/daemon.ts`, `src/wiki/service.ts`, `src/wiki/review.ts`; extend `tests/session.test.ts`, `tests/daemon-wechat.test.ts`; new `tests/daemon-wiki.test.ts`.

Add `Session.enqueueAssistant(text)` to accept an existing injected notification without awaiting the active turn. Drain accepted notifications after the Agent run settles, with transcript writes serialized and the existing `injected` event behavior. Do not mutate active model context mid-tool execution. Idle sessions can drain immediately.

Daemon Wiki callbacks acknowledge enqueue, not actual delivery. Transactions and the Wiki lock do not await the originating Session. Notification failure cannot alter commit/publication status. Queue errors are logged; queued messages and delivery waits obey daemon shutdown and cannot hold `stop()` indefinitely. This is an in-process queue, not a persistent outbox.

**Tests:** an actual WeChat Session calling `wiki_ingest` reaches idle, receives its tool result, and receives the notification; failed compilation and failed push also terminate; scheduled Wiki work can coexist with an owner request; shutdown while a notification is queued terminates. Use FakeIlink and real local Git transactions, not a mock `notify` that always resolves.

### Task 5: Expose original source retrieval as a programmatic API

**Files:** modify `skills/link-reader/scripts/read.mjs`, `src/tools/web.ts`, `src/daemon.ts`; new `src/links/source.ts`; extend `tests/link-skill.test.ts` and `tests/tools-web.test.ts`; new `tests/link-source.test.ts`.

Extract `readOriginalSource` from the existing link reader. Preserve platform extraction, redirect/host checks, cookie routing, subtitles, and configured STT. Keep CLI formatting and optional summarization as consumers of the extracted source. Do not parse the CLI's human-readable summary to reconstruct originals.

A TypeScript adapter loads the bundled MJS through `builtinSkillsDirectory()`, validates the returned shape, and maps platform text kinds into `OriginalSource`. Use `fetchPublicPage` plus existing HTML-to-Markdown extraction for generic public pages. Inject this resolver into the existing `web_fetch` factory in daemon assembly: supported platform URLs use original-source extraction, and generic URLs keep their public-page behavior. Return a versioned read receipt containing a bounded excerpt and source availability. Both paths preserve connection-time DNS validation, redirect validation, timeouts, limits, and cancellation. Cookies/keys are passed only in process memory and never exposed in results.

Original archival text is separate from the bounded CLI/model excerpt. Preserve the existing 500,000-character source processing limit: extracted bodies above it produce an explicit truncated-read receipt and are refused for complete-original archival. Bodies within it are archived without the CLI display truncation. Never label a silently clipped summary as complete original content. Metadata-only links remain readable as metadata without being marked archived.

**Tests:** WeChat and Xiaohongshu fixtures return extracted original bodies with no summarizer call; `web_fetch` returns the platform read receipt without a Wiki write; text beyond the CLI's 30,000-character display limit remains distinguishable; generic HTML uses the same network guard; private redirect and unsupported binary body are rejected; a metadata-only video is explicit; STT cancellation propagates. Source and built bundle paths both resolve.

### Task 6: Make URL ingestion one operation with an explicit receipt

**Depends on:** Tasks 1–5.

**Files:** modify `src/wiki/tools.ts`, `src/wiki/service.ts`, `src/daemon.ts`, `src/tools/summary.ts`; extend `tests/wiki-tools.test.ts`, `tests/wiki-service.test.ts`, `tests/daemon-wiki.test.ts`.

Change `wiki_ingest` parameters to accept a URL or nonempty manual text, validating the union at execution. Inject an original-source resolver into the tool factory. Check bootstrap status before retrieval/transaction; pending review returns its actual state rather than a fake read failure.

For URL requests: retrieve original → archive through run-scoped CAS tools → compile → commit → publish/retain → return the receipt. Keep the requested URL as the existing raw-file identity and include the canonical URL as source metadata. The deterministic raw write participates in the same Wiki transaction as compilation. Compile long originals as ordered segments within that transaction, at most 12,000 characters per agent call, with the raw path and segment position in each prompt. Task 9 further reduces segments to fit the final request budget. Process every segment; do not insert the entire long body into a single source prompt or substitute a generated summary for the archived original.

Return `WikiRunResult` for settled, no-change, preview, and committed-pending cases. Do not throw away the committed receipt when push/state/notification settlement fails. Reconciliation completes known pending work before new batches. On-demand runs do not advance the scheduled scan cursor. Update null/pushed-based callers, scheduler fixtures, and existing tests to consume the new result contract in the same task.

**Tests:** receipts survive an actual pi tool call and JSONL restoration and are visible in provider context; URL-only ingestion stores original bytes, compiles a page citing the raw path, and publishes both; a repeated identical URL/body does not duplicate raw files; read failure writes nothing; pre-commit compiler failure restores only attributable writes; post-commit push failure retains HEAD/marker and returns pending; remote advance/rebase changes SHA without losing batch identity; commit→marker and push→state crashes recover without a second batch or cursor rollback.

### Task 7: Add request-scoped action orchestration

**Depends on:** Tasks 5–6.

**Files:** new `src/core/execution.ts`, modify `src/core/session.ts`, `src/decision/jev.ts`, `src/decision/routing.ts`, `src/daemon.ts`; new `tests/execution.test.ts`; extend `tests/jev.test.ts` and `tests/session.test.ts`.

Assign an owner-request identity when its message enters the Agent; preserve it in transcript-compatible metadata. Maintain pending link actions independently of the compacted provider context. Match results by tool call/action ID and URL. Steering can add requests without discarding earlier outstanding actions; explicit cancellation/opt-out of an unfinished action takes precedence before its next side effect.

Classify link intent once per owner request. Jev uses bounded owner input and typed choices for archive/read/defer; URLs returned by classification must be members of the actual owner input. Tool output cannot create owner requests. At high confidence, submit one runtime `wiki_ingest({ url })` call per archive action through the normal pi loop. Read-only actions submit `web_fetch({ url })`, whose injected source adapter handles supported platforms as well as generic public pages, without Wiki mutation. Deduplicate repeated URLs within a request and process fixed actions serially.

When Jev is disabled/unavailable/uncertain, use a bounded, schema-validated intent classification call through the existing model registry. If classification remains unavailable or ambiguous, return an explicit deferred archival outcome; do not silently archive an opt-out or silently declare completion. Default-allow ingestion introduces no additional approval; configured ask/deny overrides still apply. Tool policy denial is terminal for that action, not a reason to retry through bash/delegate.

Controller-generated calls are emitted by the request/stream adapter before ordinary model generation. General model tool selection resumes after completed/blocked actions. A successful read can support a summary even when ingestion is unavailable; archival state is reported separately. Remove archival enforcement and shell-command provenance heuristics from the generic reply checker.

Automatic replay is bounded to the active request. Restart recovers committed Wiki work using its existing marker/trailer state; it does not replay historical owner messages automatically. Missing completion evidence is reported as uncertain, never invented.

**Tests:** a main model that only emits summaries still executes the required archival action once; unrelated `date` results do not satisfy a link action; explicit opt-out reads without saving; two links settle independently; steering retains the first pending action; denial is not retried through another tool; Jev outage/low confidence follows validated fallback or defer; provider retry does not repeat a successful action; stop aborts retrieval/queued actions and prevents later writes; bootstrap pending returns awaiting-review.

### Task 8: Apply one evidence boundary to parent and child output

**Depends on:** Tasks 6–7.

**Files:** modify `src/decision/routing.ts`, `src/core/execution.ts`, `src/core/session.ts`, `src/tools/delegate.ts`, `src/daemon.ts`; extend `tests/session.test.ts`, `tests/tools-delegate.test.ts`, `tests/jev.test.ts`.

Build evidence from matched calls/results and structured receipts. Keep a bounded view for Jev while retaining exact action completion state outside prompt projection. Filter configured secrets from excerpts before external evaluation; do not claim that arbitrary tool output is inherently secret-free.

Check text-bearing assistant messages even when they contain tool calls. When accompanying text is unsupported, suppress its text events and retain the valid, unexecuted calls for gated execution. Do not replay rejected text into WebChat, WeChat, history, or delegate updates. Error/abort messages expose no buffered operation claims. A truncated call remains unexecuted under the SDK's existing rule.

For unsupported final prose, permit one bounded correction. After that, render an honest fallback from concrete receipts/failures; never rerun successful side effects just to repair wording. Distinguish checker unavailability from a tool failure. Account for all provider usage, including discarded corrective generations.

Delegates inherit the same output guard and request budget, in addition to the existing execution gate. Return bounded child call/result evidence in serialized receipt content and `details.receipt`; the parent must not treat a child's unsupported final narration as a successful read/write/push. Delegate updates carry executed tool progress or checked text only. Keep the existing tool subset and recursion prohibition.

**Tests:** a message saying “saved and pushed” alongside an unexecuted read does not leak; provider-error/abort partial text does not leak; legitimate pre-tool narration is retained when supported; approval denial yields an honest answer; a lying child without tool results is not authoritative; child execution errors and cancellation reach the parent; all rejected-response usage is included; configured secret values are absent from captured Jev requests.

### Task 9: Enforce the final provider request budget

**Files:** modify `src/context/compaction.ts`, `src/providers/models.ts`, `src/core/session.ts`, `src/decision/routing.ts`, `src/tools/delegate.ts`; new `src/context/budget.ts` for the shared check; extend `tests/compaction.test.ts`, `tests/session.test.ts`, `tests/tools-delegate.test.ts`.

Reserve the actual output allowance and apply a conservative input estimate including system text, tool declarations/schema serialization, routing additions, retained messages, and images. Run the final check on the context passed to each provider, including corrective generations and child agents. A configurable compaction threshold is not the hard budget.

After compaction/fallback, verify the result again. If the latest request/system/tool loadout cannot fit, throw a typed local context-budget error. Session reports it without generic provider retry; abort propagates immediately. Preserve full transcript history and call/result pairing. Validate usable model context/output limits instead of assuming that a custom provider's defaults prove the request fits.

**Tests:** an oversized current request and oversized tool declarations cause zero provider calls; a failed summarizer cannot bypass the final check; routing instructions can trigger the guard; a fitting fallback succeeds; tool pairs and full history survive projection; child requests have the same reservation; oversized source excerpts are bounded while raw originals remain intact.

### Task 10: Align Agent profiles and owner-facing outcomes

**Depends on:** Tasks 4, 6–9.

**Files:** modify `src/daemon.ts`, `src/context/prompt.ts`, `src/tools/summary.ts`, `src/channels/wechat/messages.ts`, `skills/llm-wiki/SKILL.md`, `docs/architecture.md`, `docs/configuration.md`; extend `tests/prompt.test.ts`, `tests/daemon.test.ts`, `tests/wechat-messages.test.ts`.

Construct profile-specific prompts for interactive, Wiki, consolidation, heartbeat, and delegate runs. The Wiki profile receives the Wiki skill directly and its actual vault/Wiki tools; it must not instruct use of absent generic read/bash/delegate tools. Keep temporary-run tool restrictions, protected vault roots, and owner approval policies.

Document Jev's intent/advisory/evidence roles and the runtime's execution responsibility. Keep prompts short and describe the actual tools and receipts. Report “read”, “archived”, “compiled”, “published”, “publication pending”, and “awaiting review” accurately. A failure after a successful read retains the readable source outcome. Bootstrap review continues to use the existing explicit approval mechanism.

**Tests:** each profile declares only usable operations; a constrained Wiki run cannot acquire generic tools through MCP refresh; pending publication never renders as pushed; raw-only changes never render as changed Wiki pages; both channels show grounded results and clear preview instructions. Check all new product text is English.

### Task 11: Verify the assembled Agent and built runtime

**Depends on:** Tasks 1–10.

**Files:** new `tests/agent-workflow.test.ts`, extend `tests/daemon-wiki.test.ts`, `tests/daemon-wechat.test.ts`, `tests/daemon.test.ts`, and add bundle verification in `tests/skill-scripts.test.ts`.

Exercise `startDaemon`, the real Session/pi loop, actual policies, programmatic source extraction, Wiki transaction/state stores, and notification delivery together. Stub only external model/Jev/HTTP services. Use FakeIlink, TestClient, and temporary local bare repositories. Expose optional daemon test dependencies for the decision judge and source resolver, and a Wiki GitRunner injection for local file transport. Production defaults use the existing official services and HTTP/HTTPS Git transport.

Capture the Xiaohongshu share-text shape and WeChat article shape as local fixtures. Deliberately make the main model omit ingestion calls. Assert original raw content, Wiki citations, remote tree contents, structured receipts, owner messages, and idle/shutdown state.

Required assembled scenarios:

- WeChat and WebChat shared links read, archive, compile, publish, and terminate without extra ingestion approval.
- Explicit opt-out, unreadable/metadata-only link, multiple links, denied policy, and awaiting-review each produce their correct independent outcome.
- An external staged note and an unknown local commit never enter the remote.
- Dirty-preview rejection preserves owner content byte-for-byte.
- Commit→marker, push→state, and revert→state crash recovery preserve identities/progress and do not execute another revert.
- A committed batch with failed publication settles before new compilation; a truthful summary is still available.
- Jev/main-model failure, child unsupported claims, steering, cancellation, and shutdown obey the same execution boundaries.
- Request budget failures stop before an external provider call.

Run focused suites as each task lands. Final verification is:

```bash
npm run lint
npm test
npm run build
```

Then verify the built entry and bundled source-reader/Wiki skill through the same isolated fixtures, without live keys or the real vault. If a Docker image is built for validation, mount a temporary data home and local test remote only; do not recreate the production container as part of test verification.

## Acceptance and delivery

All seven reviewed problems have direct required-behavior regression tests. Parent/child evidence, steering, cancellation, bootstrap gating, crash recovery, and both chat channels also have integration assertions. Existing tests remain green, and the full build includes browser assets and bundled skills.

Review the complete implementation diff against the invariants and receipts, with particular attention to calls that mutate Git or await Session state. Verification results distinguish automated fixtures from any separately authorized live test. The final handoff identifies changed interfaces, validation results, and the remaining X concurrency boundary; it does not claim that probabilistic judgments guarantee semantic accuracy or that transient notifications survive a process crash.
