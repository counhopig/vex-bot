# Complexity Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the wiki's three-source crash protocol into git-as-single-truth, converge `vex*` transcript casts into one typed boundary, centralize owner delivery, fix two bugs, and split `app.js` into native ES modules.

**Architecture:** Git history becomes the only derivation of wiki batch/bootstrap/rollback/scan-cursor state (marker keeps only uncommitted writes, state file keeps only runtime backoff data); transcript metadata access is funneled through `core/transcript.ts`; owner notification goes through one small `core/delivery.ts`; the browser keeps its no-build convention with real ES modules.

**Tech Stack:** TypeScript ESM (Node ≥24), pi-agent-core/pi-ai, better-sqlite3, ws, Vitest, plain JS ES modules for the browser.

**Spec:** `docs/superpowers/specs/2026-11-18-complexity-reduction-design.md`

## Global Constraints

- Node ≥24, ESM: relative imports end in `.js`; Node built-ins use `node:`.
- Style: double quotes, two spaces, semicolons; `tsc` strict with `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`.
- `npm run lint` = `tsc --noEmit` AND `tsc -p tsconfig.web.json` (type-checks browser JS). Both must pass in every task.
- Tests: Vitest, 20s default timeout; test helpers in `tests/helpers/` (see `tests/AGENTS.md`).
- Every task ends with `npm run lint && npm test` green.
- Commits: Conventional Commits, English subjects, no AI attribution (no Co-authored-by, no 🤖).
- TDD: failing test before implementation for every kept or fixed behavior.
- No new dependencies. No wire-protocol changes.

## Review Focus

Inputs or conditions the spec implies but whose tests must not be forgotten, with the test that pins each:

1. **Old-format state/marker files must degrade to "absent"/partial, never throw at open** — spec migration section. Test: Task 5, Step 1 (parse-level: old `wiki.json` keeps backoff fields, old marker with `phase` parses as a writing marker).
2. **Stale marker + clean tree self-heals; stale marker + dirty tree refuses (integrity), never silently discards foreign writes** — spec crash-window section. Tests: Task 5, Steps 1 and 6.
3. **A scheduled no-change run leaves the scan cursor derived from the last published batch; the next run must detect zero changes again, not recompile an old range** — spec behavior-parity requirement. Test: Task 5, Step 1 (case d).
4. **On-demand dedup applies only when the newest batch is unpublished; a source archived in an already-published batch recompiles (today's behavior)** — spec "exactly as today" requirement. Test: Task 6, Step 1.
5. **InjectAssistant aborted mid-wait rejects with the signal's reason and leaves the session usable** — spec delivery section. Test: Task 8, Step 1.

---

### Task 1: Lockout hard cap

**Files:**
- Modify: `src/gateway/server.ts` (`Lockout` class, ~lines 67-84; add `export`)
- Test: `tests/gateway.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export class Lockout` with the existing `locked(address)` and `fail(address)` methods; behavior: the map never exceeds 1024 entries.

- [ ] **Step 1: Write the failing tests**

Add to `tests/gateway.test.ts` (import `Lockout` from `../src/gateway/server.js`; use `vi.useFakeTimers` where expiry matters):

```ts
it("evicts the oldest entry when the lockout map is full", () => {
  const lockout = new Lockout();
  for (let index = 0; index < 1024; index++) lockout.fail(`10.0.${index >> 8}.${index & 255}`);
  expect(lockout.locked("10.0.0.0")).toBe(true);
  lockout.fail("11.0.0.1"); // over capacity: oldest entry must go
  expect(lockout.locked("11.0.0.1")).toBe(true);
  expect(lockout.locked("10.0.0.0")).toBe(false);
});

it("still prunes expired entries on failure", () => {
  vi.useFakeTimers();
  try {
    const lockout = new Lockout();
    lockout.fail("10.1.1.1");
    vi.advanceTimersByTime(1100);
    lockout.fail("10.1.1.2"); // prunes the expired entry, stays small
    expect(lockout.locked("10.1.1.1")).toBe(false);
    expect(lockout.locked("10.1.1.2")).toBe(true);
  } finally { vi.useRealTimers(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/gateway.test.ts`
Expected: FAIL — first test: the map grows to 1025 and `10.0.0.0` stays locked.

- [ ] **Step 3: Implement the cap in `Lockout.fail`**

In `fail()`: after the existing expired-entry prune, if `this.until.size >= 1024`, delete the first key of `this.until` (insertion order = oldest, `Map` iteration order) regardless of expiry, then set the new entry. `locked()` and the expired-prune logic are unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/gateway.test.ts`
Expected: PASS (both new tests and the whole suite).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/server.ts tests/gateway.test.ts
git commit -m "fix: give the gateway lockout a real entry cap"
```

---

### Task 2: WeChat interrupted turns report their delivery

**Files:**
- Modify: `src/channels/wechat/channel.ts:306-311` (`deliverTurn`)
- Test: `tests/wechat-channel.test.ts`

**Interfaces:**
- Consumes: existing `WeChatChannel` test scaffolding in the suite.
- Produces: no signature change; `replyDelivered()` now resolves `true` after an interrupted turn whose (partial) reply was sent.

Note: the interrupted branch already passes the `onReplyDelivery` report (the trace note is correct); the bug is only that `this.lastReply` is never assigned there, so `replyDelivered()` reports `false` for text the owner actually received.

- [ ] **Step 1: Write the failing test**

In `tests/wechat-channel.test.ts`, following the suite's existing patterns for driving bus events into a channel with a recording fake client:

```ts
it("reports delivery for an interrupted turn that sent its partial reply", async () => {
  // Build a channel whose fake client records sendText calls and succeeds.
  // Emit { type: "session", sessionKey: WECHAT_SESSION_KEY, event: { kind: "busy", busy: true } }
  // then   { ... event: { kind: "turn_end", reply: "partial answer", status: "interrupted" } }.
  expect(sentTexts).toEqual(["partial answer\n(interrupted)"]);
  await expect(channel.replyDelivered()).resolves.toBe(true);
});

it("reports delivery for an interrupted turn with no reply", async () => {
  // Same, with reply "".
  expect(sentTexts).toEqual(["Interrupted."]);
  await expect(channel.replyDelivered()).resolves.toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/wechat-channel.test.ts`
Expected: FAIL — `replyDelivered()` resolves `false` although `sendText` was called.

- [ ] **Step 3: Assign `lastReply` in the interrupted branch**

In `deliverTurn`, make the interrupted branch assign `this.lastReply = this.send(..., report)` just like the normal branch.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/wechat-channel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/wechat/channel.ts tests/wechat-channel.test.ts
git commit -m "fix: count an interrupted WeChat turn's partial reply as delivered"
```

---

### Task 3: Flatten `pushWithRetry` and deduplicate rollback validation (pure refactor)

**Files:**
- Modify: `src/vault/wiki/service.ts` (`pushWithRetry` ~lines 917-949, `settleRollback` ~lines 869-897)
- Test: existing suites only (`tests/wiki-service.test.ts`, `tests/wiki-reconcile.test.ts`)

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change; `settleRollback` gains one private helper used by both of its branches.

- [ ] **Step 1: Extract the rollback-trailer validator**

In `service.ts`, add one private async helper, e.g. `findValidatedRollbackCommit(revertId: string, expectedTargetBatchId: string): Promise<string>`, that does what both duplicated blocks do: `findCommit("Vex-Rollback", revertId)`, refuse when missing, parse trailers, require exactly one `vex-revert-of` equal to `expectedTargetBatchId`. Both branches of `settleRollback` call it.

- [ ] **Step 2: Flatten `pushWithRetry`**

Rewrite the three nested try/catch as a loop bounded at two push attempts: `for (let attempt = 0; attempt < 2; attempt++) { checkIntegrity; cleanTree if requireClean; throwIfAborted; try push → return; catch: rethrow if aborted/integrity } fetch; rebase; }` — keeping the trailing acceptance: after the second failed push, if `isAncestor(head, originHead)` the push is already published, return success; otherwise rethrow the last error.

- [ ] **Step 3: Run the wiki suites**

Run: `npm test -- tests/wiki-service.test.ts tests/wiki-reconcile.test.ts tests/wiki-integration.test.ts`
Expected: PASS (no behavior change; this is a fold, tests are the regression net).

- [ ] **Step 4: Commit**

```bash
git add src/vault/wiki/service.ts
git commit -m "refactor: flatten wiki push retry and deduplicate rollback validation"
```

---

### Task 4: Make `reconcile` a pure derivation (drop its state input)

**Files:**
- Modify: `src/vault/wiki/reconcile.ts`; `src/vault/wiki/service.ts` (call sites: `runReconcile`, `rollback`, `settleRollback`)
- Test: `tests/wiki-reconcile.test.ts`

**Interfaces:**
- Consumes: `WikiRepo`, `InFlightMarker` (marker shape unchanged in this task).
- Produces:
  - `reconcile(input: { repo: WikiRepo; marker: InFlightMarker | null; bootstrapRef: string | null }): Promise<ReconcileResult>`
  - `ReconcileResult` loses `markerResolution: "none" | "committed" | "writing"` and gains `staleMarker: boolean` (true when a `Vex-Batch` trailer matching `marker.batchId` exists in the scanned history — the same detection the old `"committed"` resolution used).

- [ ] **Step 1: Rewrite the failing tests in `tests/wiki-reconcile.test.ts`**

Re-pin the contract: remove every case that supplies `state` (state fallback rules die); add cases for: `staleMarker` true/false; bootstrap done only from a published bootstrap batch **or** a resolvable `bootstrapRef`; pending rollback only from history (`Vex-Rollback`/`Vex-Revert-Of` pairs); `lastScanCommit` only from published advancing batches' `Vex-Scan-Base` (no state cursor candidate); reset epoch still cuts history scanning and still expires a pre-reset `bootstrapRef`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/wiki-reconcile.test.ts`
Expected: FAIL (reconcile still requires/takes `state`).

- [ ] **Step 3: Implement**

In `reconcile.ts`: drop the `state` input and `WikiState`/`WikiRollback` imports (keep `WikiRollback` in the result type — define it locally or import from where it lands in Task 5; for this task, move the interface into `reconcile.ts` and have `state.ts` import it from there); rename the marker/commit detection to produce `staleMarker`; delete rules 4-6's state fallbacks (state cursor candidate, `state.bootstrap === "done"`, `state.rollback.targetBatchId` probe); keep the reset trailer break and the bootstrapRef-after-reset expiry check. In `service.ts`: `runReconcile` drops its `state` argument and the memo key drops state; `rollback()`'s `reconciled.rollback || state?.rollback` becomes `reconciled.rollback`; `settleRollback` drops its `state` parameter and the `state.rollback` recovery branch (the git-derived branch covers it).

- [ ] **Step 4: Run the wiki suites**

Run: `npm test -- tests/wiki-reconcile.test.ts tests/wiki-service.test.ts tests/wiki-integration.test.ts`
Expected: PASS (rewrite service-level cases that asserted state-fallback recovery; history-derived recovery covers them).

- [ ] **Step 5: Commit**

```bash
git add src/vault/wiki/reconcile.ts src/vault/wiki/service.ts tests/wiki-reconcile.test.ts tests/wiki-service.test.ts
git commit -m "refactor: derive all wiki recovery state from git history"
```

---

### Task 5: The core wiki collapse — marker and state shrink, settle-path deletion

**Files:**
- Modify: `src/vault/wiki/marker.ts`, `src/vault/wiki/state.ts`, `src/vault/wiki/batch.ts`, `src/vault/wiki/service.ts`, `src/vault/wiki/reconcile.ts` (type moves), `src/daemon.ts` only if it imports removed symbols (it does not today)
- Test: `tests/wiki-marker.test.ts`, `tests/wiki-state.test.ts`, `tests/wiki-batch.test.ts`, `tests/wiki-service.test.ts`, `tests/wiki-integration.test.ts`, `tests/daemon-wiki.test.ts`

**Interfaces:**
- Consumes: Task 4's `reconcile` signature and `staleMarker`.
- Produces (exact shapes later tasks and tests rely on):

```ts
// marker.ts
export interface InFlightMarker {
  batchId: string;
  kind: "scheduled" | "bootstrap" | "on-demand";
  scanBase: string | null;
  baseHead: string;
  touched: TouchedPath[];
}
// MarkerStore keeps read/begin/recordIntent/recordAfter/remove; setCommitted is deleted.

// state.ts
export interface WikiState {
  failureStreak: number;
  nextAttemptAt: number | null;
  lastRunAt: number | null;
  bootstrapDeferred?: true;
}
```

- [ ] **Step 1: Re-pin the formats and recovery contract in tests**

In `tests/wiki-marker.test.ts` and `tests/wiki-state.test.ts`: marker parse accepts the new shape and **ignores unknown extra fields** (so an old marker carrying `phase`/`commit` parses as a plain writing marker); state parse accepts old files and extracts the surviving runtime fields (`failureStreak`, `nextAttemptAt`, `lastRunAt`, optional `bootstrapDeferred`), treating them as absent when missing/invalid. In `tests/wiki-service.test.ts`: delete the committed-marker suites (`settleCommittedBatch`, `recoverCommittedBatch`, `validateCommittedMarker`, "keeps a committed compile marker when its commit blob does not match", "returns a pending receipt when push succeeds but state settlement fails") and add: (a) crash between commit and marker removal → next run sees `staleMarker` + clean tree → heals by deleting the marker (Review Focus 2); (b) stale marker + dirty tree → `WikiIntegrityError`; (c) a push that succeeds while the state write fails reports **published** (spec's known difference); (d) a scheduled no-change run writes no scan cursor, and the next scheduled run still detects zero changes (Review Focus 3); (e) old-format `state/wiki.json` keeps its backoff after open (Review Focus 1).

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/wiki-marker.test.ts tests/wiki-state.test.ts tests/wiki-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Shrink `marker.ts` and `state.ts`**

`marker.ts`: new `InFlightMarker` (drop `advancesScan`, `phase`, `commit`); delete `setCommitted`; `parseMarker` validates the surviving fields and ignores extras. `state.ts`: new `WikiState` with permissive parse per Step 1; `emptyState()` returns `{ failureStreak: 0, nextAttemptAt: null, lastRunAt: null }`.

- [ ] **Step 4: Update `batch.ts` and `reconcile.ts` for the new marker**

`batch.ts`: delete both `inFlight.phase !== "writing"` guards (`inspectAndCleanTree`, `abortBatch`) — a marker present is a writing marker now; adjust the doc comments. `reconcile.ts`: keep `staleMarker` as-is (batchId-in-history detection is independent of the removed fields).

- [ ] **Step 5: Rebuild `service.ts`**

- `fetchAndReconcile`: after reconcile, stale-marker handling — if `reconciled.staleMarker`: clean tree (`statusEntries` empty) → `marker.remove()`, dirty tree → throw `WikiIntegrityError`; drop the `pendingCompile` variable entirely.
- `settlePrevious`: delete the committed-marker branches and the whole pending-batch receipt return; the body becomes: clean the tree (`inspectAndCleanTree` for a present writing marker, plain `cleanTree` check otherwise), settle a history-derived pending rollback, rebase, publish unpublished local commits, return `{ baseHead }`.
- Delete `settleCommittedBatch`, `recoverCommittedBatch`, `validateCommittedMarker` (also its call inside `checkIntegrity`), and `clearBatchRef` (rollback settlement now flips purely on git state).
- `commitBatch`: after a successful commit, delete the stale-marker bookkeeping and `marker.remove()` immediately (design: marker removed on commit, not on publish); the "setCommitted failed → pending receipt" branch reduces to push-failure-only.
- `publishBatch`: success-path state write becomes `{ ...current, failureStreak: 0, nextAttemptAt: null, lastRunAt: now }`; the trailing `marker.remove()` disappears (the marker already went at commit time); push failure keeps the pending receipt + `recordFailure()`.
- `recordNoChange`: writes only `{ ...current, failureStreak: 0, nextAttemptAt: null, lastRunAt: now }`; keeps updating `BOOTSTRAP_REF` on bootstrap (that ref is the only "bootstrap done" evidence for a no-change bootstrap); no scan-cursor write — the cursor is the last published batch's `Vex-Scan-Base` trailer.
- `rollback`: drop the `state?.rollback` write; the durable pending-rollback record is the revert commit itself.
- `approveBootstrap` / `rejectBootstrap` / `rebuild`: state writes reduce to the surviving fields (`approveBootstrap` → backoff reset + `lastRunAt`; `rejectBootstrap` → `bootstrapDeferred: true`; `rebuild` → `emptyState()`, epoch evidence is the reset trailer).
- `runContext`, `dueWork`, `status`, `remindPendingPreview`, `preview`: adapt to removed fields (`status`' bootstrap comes from reconcile; keep `bootstrapDeferred` from state).

- [ ] **Step 6: Run the full wiki matrix**

Run: `npm test -- tests/wiki-marker.test.ts tests/wiki-state.test.ts tests/wiki-batch.test.ts tests/wiki-service.test.ts tests/wiki-integration.test.ts tests/wiki-integrity.test.ts tests/daemon-wiki.test.ts`
Expected: PASS, including Review Focus cases 1-3.

- [ ] **Step 7: Lint and full test run**

Run: `npm run lint && npm test`
Expected: both green.

- [ ] **Step 8: Commit**

```bash
git add src/vault/wiki tests
git commit -m "refactor: collapse wiki recovery to git as the single source of truth"
```

---

### Task 6: On-demand idempotent receipt from git-derived data

**Files:**
- Modify: `src/vault/wiki/service.ts` (`run` / `fetchAndReconcile` / `ingestSource` seam)
- Test: `tests/wiki-service.test.ts`, `tests/wiki-integration.test.ts`

**Interfaces:**
- Consumes: `reconcile().lastBatchId`, `findCommit("Vex-Batch", id)`, `repo.changedPaths(sha)`, `repo.fingerprintAt(sha, path)`, `sourceDocument(source, url, text)` (existing, `service.ts:39`), `wikiRawPath` (existing).
- Produces: no new exports; on-demand `run({ kind: "on-demand", source })` with `source.url` and `source.text` returns the existing batch's receipt without recompiling when the newest batch is **unpublished** and its `raw/` archive for this URL is byte-identical (`sha256` of `sourceDocument`) to what this request would write.

- [ ] **Step 1: Write the failing tests**

In `tests/wiki-service.test.ts`: (a) newest batch unpublished + its `raw/` path hash equals the request's `sourceDocument` hash → `run` returns `{ batchId, commit, pages, publication: "pending" }` with **no** `runAgent` call; (b) same but the batch **is** published → `runAgent` called, a new batch compiles (Review Focus 4); (c) hash mismatch → recompiles.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/wiki-service.test.ts`
Expected: FAIL (retry currently recompiles — the old dedup lived in the deleted committed-marker path).

- [ ] **Step 3: Implement the check in the on-demand path**

Add one private helper, e.g. `archivedReceipt(request): Promise<WikiRunResult | null>`: resolve `reconciled.lastBatchId` → `findCommit` → if the batch is an ancestor of `originHead` return null (published); compute `expected = sha256(sourceDocument(source, url, source.text))`; `fingerprintAt(sha, wikiRawPath(url))` matches (type `file`, same hash) → return `{ batchId, commit, pages: changedPaths(sha).filter(startsWith "wiki/"), publication: "pending" }`, else null. Call it from `run`'s on-demand branch before `settle`'s compile.

- [ ] **Step 4: Run the wiki matrix**

Run: `npm test -- tests/wiki-service.test.ts tests/wiki-integration.test.ts tests/daemon-wiki.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/wiki/service.ts tests/wiki-service.test.ts
git commit -m "feat: restore on-demand wiki receipt dedup from git-derived state"
```

---

### Task 7: Transcript metadata boundary

**Files:**
- Modify: `src/core/transcript.ts` (add helpers), `src/core/session.ts:239,381-384,393-397,520,561`, `src/core/history.ts:34`, `src/index/memory.ts:121-128`, `src/context/compaction.ts:65`
- Test: `tests/store.test.ts` or a new `tests/transcript.test.ts` (prefer adding to `tests/session.test.ts`-adjacent; the repo has no transcript suite yet — create `tests/transcript.test.ts`)

**Interfaces:**
- Consumes: `AgentMessage`, `UserMessage`, `AssistantMessage` from pi-agent-core/pi-ai.
- Produces (disk format unchanged — same field names `vexSource`/`vexRequestId`/`vexNotice`/`vexRun`):

```ts
export interface TranscriptMeta { source?: string; requestId?: string; notice?: boolean; run?: string }
export function transcriptMeta(message: AgentMessage): TranscriptMeta
export function attachTranscriptMeta(message: UserMessage, meta: { source?: string; requestId?: string }): UserMessage
export function noticeAssistantMessage(text: string, model: { api: string; provider: string; id: string }): AssistantMessage
export function withRun(message: AgentMessage, run: string | undefined): AgentMessage
export function isNotice(message: AgentMessage): boolean
```

- [ ] **Step 1: Write the failing tests**

New `tests/transcript.test.ts`: round-trip — `attachTranscriptMeta` then `transcriptMeta` returns the same values; `noticeAssistantMessage` carries `vexNotice` and `isNotice` is true for it and false for a plain assistant message; `withRun` stamps `vexRun`; `transcriptMeta` on a message with no fields returns `{}`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/transcript.test.ts`
Expected: FAIL (helpers don't exist).

- [ ] **Step 3: Implement helpers in `src/core/transcript.ts`**

Plain field reads/writes; `noticeAssistantMessage` builds the same assistant message `session.ts:381-384` builds today (zero usage, `stopReason: "stop"`, `timestamp`, `vexNotice: true`).

- [ ] **Step 4: Swap the eight cast sites**

`session.ts:239` → `attachTranscriptMeta`; `381-384` → `noticeAssistantMessage`; `393-397` → `withRun`; `520` → `transcriptMeta`; `561` (`markNotice`) → `isNotice` from the boundary (the label rewrite stays local to session). `history.ts:34` → `source: transcriptMeta(message).source`. `memory.ts` cast block → `const meta = transcriptMeta(entry.message)` with `meta.source`/`meta.run`. `compaction.ts:65` → `transcriptMeta(m).source`. Run `grep -n "vexSource\|vexRequestId\|vexNotice\|vexRun" src` afterwards: remaining hits must be `core/transcript.ts` only.

- [ ] **Step 5: Run tests and lint**

Run: `npm run lint && npm test`
Expected: green; grep shows the boundary is the only toucher.

- [ ] **Step 6: Commit**

```bash
git add src/core/transcript.ts src/core/session.ts src/core/history.ts src/index/memory.ts src/context/compaction.ts tests/transcript.test.ts
git commit -m "refactor: route all transcript metadata access through one typed boundary"
```

---

### Task 8: Rewrite `Session.injectAssistant`'s wait as a deferred + abort

**Files:**
- Modify: `src/core/session.ts:331-344` (`injectAssistant`)
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: same public signature `injectAssistant(text: string, signal?: AbortSignal): Promise<void>`; identical behavior, implemented with one deferred promise and an abort listener instead of the hand-rolled promise-settling race.

- [ ] **Step 1: Write the failing tests**

The behavior is unchanged, so the failing-test step is a characterization gap: in `tests/session.test.ts` assert (a) aborting the signal while the session is busy rejects with `signal.reason` (not a generic Error), (b) a session that goes idle between waits resolves and delivers, (c) rejection leaves the session usable (a later `send` starts a turn). If the suite already covers these, add only what is missing.

- [ ] **Step 2: Run to establish the baseline**

Run: `npm test -- tests/session.test.ts`
Expected: PASS (these pin current behavior before the surgery; the new tests must already pass — if any fails, the rewrite would have changed behavior, so fix the test first).

- [ ] **Step 3: Rewrite the wait**

Extract a private `waitIdleOrAbort(signal?: AbortSignal): Promise<void>`: one deferred; `whenIdle().then(resolve)`; abort listener rejects with `signal.reason`; both remove the listener. `injectAssistant` becomes: `while (this.busy) await this.waitIdleOrAbort(signal); signal?.throwIfAborted(); ...` keeping the closing-check and `deliverAssistant`.

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/session.test.ts tests/session-manager.test.ts`
Expected: PASS (Review Focus 5 case included).

- [ ] **Step 5: Commit**

```bash
git add src/core/session.ts tests/session.test.ts
git commit -m "refactor: rewrite injectAssistant wait as a deferred promise with abort"
```

---

### Task 9: Owner delivery module

**Files:**
- Create: `src/core/delivery.ts`
- Modify: `src/daemon.ts:144,221,256` (wiki `notify`, watchdog `deliver`, heartbeat `deliverHeartbeat`)
- Test: `tests/session.test.ts`-adjacent new `tests/delivery.test.ts`

**Interfaces:**
- Consumes: `Session` from `core/session.js` (public methods only).
- Produces:

```ts
export interface OwnerDelivery {
  /** Queue a runtime notice; drained after the current turn settles. */
  notify(text: string): Promise<void>;
  /** Wait for idle and inject into the owner transcript; abortable. */
  inject(text: string, signal?: AbortSignal): Promise<void>;
}
export function createOwnerDelivery(deps: { wechatSession: () => Promise<Session> }): OwnerDelivery
```

Spec deviation, deliberate: the design's third semantic ("send", plain `send`) has **no owner-path call site** once scheduler/tasks routing stays in its own hooks (design's own scope note); per the program's no-new-architecture rule the module ships the two methods that exist. The scheduler `deliver` hook (`daemon.ts:237`), tasks `deliver` (`daemon.ts:199`) and the outreach session getter (`daemon.ts:257`/**`persona/outreach.ts:11`**) are intentionally untouched.

- [ ] **Step 1: Write the failing tests**

New `tests/delivery.test.ts`, with a fake `Session` object: `notify` calls `enqueueAssistant`; `inject` calls `injectAssistant` with the signal; `wechatSession` resolution failures propagate to the caller.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/delivery.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `createOwnerDelivery`**

Thin adapter: `notify: (text) => wechatSession().then((s) => s.enqueueAssistant(text))`; `inject: (text, signal) => wechatSession().then((s) => s.injectAssistant(text, signal))`. No logging, no policy — the hooks keep their own log lines.

- [ ] **Step 4: Wire the daemon hooks**

In `daemon.ts`: create `const ownerDelivery = createOwnerDelivery({ wechatSession: () => sessions.get(WECHAT_SESSION_KEY) })` after `sessions.init()`; wiki `notify` becomes `(text) => ownerDelivery.notify(text)`; watchdog `deliver` keeps its abort check and log, then `ownerDelivery.inject(text, signal)`; `deliverHeartbeat` likewise.

- [ ] **Step 5: Run tests and lint**

Run: `npm run lint && npm test`
Expected: green (`tests/daemon.test.ts`, `tests/watchdog.test.ts`, `tests/daemon-wechat.test.ts` adapted if they stub the old closure seam).

- [ ] **Step 6: Commit**

```bash
git add src/core/delivery.ts src/daemon.ts tests/delivery.test.ts
git commit -m "refactor: centralize WeChat owner delivery behind one module"
```

---

### Task 10: Browser split — loader plus the leaf modules

**Files:**
- Create: `src/web/static/ui.js`, `src/web/static/state.js`, `src/web/static/net.js`, `src/web/static/markdown.js`
- Modify: `src/web/static/app.js` (remove the moved code, import the new modules), `src/gateway/server.ts` (`STATIC_FILES` entries for the four new paths, `text/javascript`, `public: false`), `tsconfig.web.json` (includes, if file-scoped)
- Test: `tests/web-app.test.ts` (gains the module loader)

**Interfaces:**
- Consumes: nothing.
- Produces (the module DAG; later tasks import from these):
  - `ui.js`: `$(id)`, `$field(id)`, `element(tag, className, text)`
  - `state.js`: `export const state = {...}` (the single shared state object, verbatim from today's `app.js`), plus the small consts on it
  - `net.js`: `send(message): boolean`, `connect(dispatch: (msg) => void)`
  - `markdown.js`: `parseMarkdown`, `renderMarkdown`, `renderBlocks`, `copyText`, and the other render helpers (today's `app.js` ~lines 202-423)
- Constraint for all browser modules: **no import cycles** — the test loader evals in dependency order, so `app.js` is the only module allowed to import every other module.

- [ ] **Step 1: Add the module loader to `tests/web-app.test.ts`**

Replace `loadApp`'s single-file `readFile` with a loader: read `["ui.js", "state.js", "net.js", "markdown.js", "app.js"]` in that order from `src/web/static/`, strip lines matching `^import .+;$` and the `^export ` prefix on remaining lines (project style: single-line imports, named exports only, no `export default`), and `runInContext` them sequentially into the same context. Existing binding-level assertions (`state.ws`, `handle(...)`) must keep working unchanged.

- [ ] **Step 2: Run the suite to verify the loader works on the monolith first**

Verify by pointing the loader's tail at only `app.js` (no imports yet): Run: `npm test -- tests/web-app.test.ts`. Expected: PASS. Restore the full list after.

- [ ] **Step 3: Extract the four leaf modules; adapt `app.js` imports**

Move today's `app.js` regions into the new files per the Produces block: `$`/`$field`/`element` → `ui.js`; the `state` object → `state.js`; `send`/`connect` → `net.js` (`connect` takes the dispatcher as a parameter so `net.js` never imports chat code); markdown parsing/rendering (~lines 202-423) → `markdown.js`. `app.js` imports them; every other symbol stays in `app.js` for now. Add `/ui.js`, `/state.js`, `/net.js`, `/markdown.js` to `STATIC_FILES` (`public: false`). Verify serving stays auth-gated: extend `tests/gateway.test.ts` with one case: GET `/markdown.js` without a session cookie on a token-required server → 401 (Review Focus browser auth).

- [ ] **Step 4: Run tests and lint**

Run: `npm run lint && npm test -- tests/web-app.test.ts tests/gateway.test.ts`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/web/static src/gateway/server.ts tests/web-app.test.ts tests/gateway.test.ts tsconfig.web.json
git commit -m "refactor: split browser leaf modules from app.js behind a vm loader"
```

---

### Task 11: Browser split — chat and schedules surfaces

**Files:**
- Create: `src/web/static/chat.js`, `src/web/static/schedules.js`
- Modify: `src/web/static/app.js`, `src/gateway/server.ts` (two more `STATIC_FILES` entries), `tests/web-app.test.ts` (loader order)
- Test: `tests/web-app.test.ts`

**Interfaces:**
- Consumes: Task 10's `ui.js`, `state.js`, `net.js`, `markdown.js`.
- Produces:
  - `chat.js`: session list/history/bubble/tool rendering and the panel renderers (`renderSessions`, `renderHistory`, `applyEvent`, `addBubble`, `addTool`, `updateTool`, `addNotice`, `setBusy`, `renderApprovals`, `renderTasks`, `renderTriggers`, `renderStatusLine`, `clearMessages`, session selection helpers — today's ~lines 424-754 minus drawer/theme)
  - `schedules.js`: `renderSchedules`, `renderScheduleForm`, `editSchedule`, `scheduleMessage`, `describeRule`, `targetLabel`, `localInput`, `pad2` (today's ~lines 1243-1400)
- DAG rule: `chat.js`/`schedules.js` import only `ui`, `state`, `net`, `markdown`; `app.js` imports them.

- [ ] **Step 1: Extend the loader order and extract**

Loader order becomes `ui, state, net, markdown, chat, schedules, app`. Move the two regions; `app.js`'s `handle` dispatcher imports their functions and passes nothing back (events flow through the shared `state` object exactly as today).

- [ ] **Step 2: Run tests and lint**

Run: `npm run lint && npm test -- tests/web-app.test.ts`
Expected: green, with zero assertion changes in the suite (the split must be behavior-invisible).

- [ ] **Step 3: Commit**

```bash
git add src/web/static src/gateway/server.ts tests/web-app.test.ts
git commit -m "refactor: split chat and schedules surfaces into browser modules"
```

---

### Task 12: Browser split — settings (with files) and traces; final core

**Files:**
- Create: `src/web/static/settings.js`, `src/web/static/traces.js`
- Modify: `src/web/static/app.js` (keeps: `state` wiring via import, `handle` dispatcher, navigation `showChat`/`showSettings`/`showTraces`/`leaveTraces` if they touch cross-surface state, drawer/theme, init), `src/gateway/server.ts` (final two `STATIC_FILES` entries), `tests/web-app.test.ts` (final loader order)
- Test: `tests/web-app.test.ts`

**Interfaces:**
- Consumes: Tasks 10-11 modules.
- Produces:
  - `settings.js`: the settings form and file editors together (the files surface shares the settings page and its tabs — design's separate `files.js` folds in here): `renderSettingsTabs`, `renderFileTabs`, `renderFileEditors`, `renderNotes`, `openNote`, `makeSettings`, `renderField`, `buildPatch`, `saveSettings`, `showSaved` (today's ~lines 880-1242, 1401-1429)
  - `traces.js`: the whole trace viewer incl. its `state.traces` mini-state (today's ~lines 1467-2004)
- `app.js` ends as the dispatcher, navigation, theme/drawer, and bootstrap wiring only (target: well under 400 lines).

- [ ] **Step 1: Extract and finalize the loader order**

`ui, state, net, markdown, chat, schedules, settings, traces, app`. Move both regions; finish `app.js` as the core. Confirm `tsconfig.web.json` covers all new files and `npm run lint` passes.

- [ ] **Step 2: Run the full verification**

Run: `npm run lint && npm test`
Expected: fully green across all suites.

- [ ] **Step 3: Update the map in `src/AGENTS.md`**

The runtime structure map lists `web/static` as "browser handlers and presentation" — still true, but add one line noting the module split (`app.js` dispatcher + surface modules, vm loader in `tests/web-app.test.ts`). Keep it to the file's existing style.

- [ ] **Step 4: Commit**

```bash
git add src/web/static src/gateway/server.ts tests/web-app.test.ts src/AGENTS.md tsconfig.web.json
git commit -m "refactor: split settings and traces modules out of the browser core"
```

---

## Definition of done (program level)

- `npm run lint && npm test` green after every task (no red windows between commits).
- `grep -rn "vexSource\|vexRequestId\|vexNotice\|vexRun" src` hits only `src/core/transcript.ts`.
- `vault/wiki` line count ≈ 2,300 (down from 2,734); `service.ts` ≈ 650.
- `daemon.ts` has no direct `sessions.get(WECHAT_SESSION_KEY)` delivery outside `ownerDelivery` and the outreach getter.
- `src/web/static/app.js` < 400 lines; every module path served by `STATIC_FILES` with `public: false`.
