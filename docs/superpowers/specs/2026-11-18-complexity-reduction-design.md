# Vex complexity reduction — design

**Date:** 2026-11-18
**Source:** full-project review of this session (Linus-style audit), user decisions on scope and compatibility.
**Status:** awaiting owner approval.

## Intent

The 2026-11-18 review rated the codebase "usable but with problems": the core session/policy/gateway machinery is good, but five areas carry more complexity than their problems warrant, plus two small bugs. This design turns that review into one executable program of work.

The why, in one line each:

1. **Wiki recovery** — 2,734 lines under `vault/wiki/` guard an optional feature with a three-source-of-truth crash protocol (marker file + state file + git trailers) that then needs 245 lines of reconciliation and ~400 lines of settle/recover branches to keep the sources agreeing.
2. **Transcript casts** — the `vex*` metadata fields (`vexSource`, `vexRequestId`, `vexNotice`, `vexRun`) are pasted onto library `AgentMessage` objects and re-cast at eight scattered sites (`core/session.ts`, `core/history.ts`, `index/memory.ts`, `context/compaction.ts`).
3. **Owner delivery** — three `daemon.ts` closures hand-roll delivery to the WeChat owner session with three different implicit semantics; `injectAssistant` contains a hand-written promise/abort race. Two further closures (scheduler `deliver`, tasks `deliver`) route to *arbitrary* sessions and are a different concept (turn-driving, not owner notification).
4. **Bugs** — `Lockout`'s 1024 cap is not actually a cap; `deliverTurn` misreports interrupted deliveries.
5. **`app.js`** — a 2,004-line single file has passed the threshold where "no build step" justifies monolith.

## Owner decisions already made

- **Scope:** all five areas, one program, ordered below.
- **Compatibility:** **none required.** Wiki on-disk formats may be redesigned freely; no published-format obligations (no external deployments to protect).

## Goals

1. Wiki crash recovery derives from **one source of truth: git history**; marker and state shrink to what git cannot express.
2. All `vex*` transcript field access goes through **one typed boundary module**; zero casts outside it.
3. Owner delivery to the WeChat session is **one module with three named semantics**; the scheduler/tasks target-routing hooks keep their existing closures (they drive turns in arbitrary sessions, which is scheduler protocol, not owner notification).
4. `Lockout` gets a real cap; interrupted WeChat turns report delivery truthfully.
5. `app.js` splits into native ES modules with **no build step**.

## Non-goals

- No wire-protocol changes (`protocol/messages.ts` stays as is; server and browser ship together).
- No redesign of `WikiLock` / `readCopy.ts` (52 + 50 lines, already the minimal "reads never wait" implementation).
- No daemon assembly restructuring — re-evaluate the "add a tool touches 6 files" bill **after** the wiki collapse removes its share of the coupling.
- No rewrite of the link-action `fauxToolCall` mechanism (boundary is correct; risk > benefit).
- No optimization of the per-request `withSystemPrompt` copy (correct, cost negligible).

## Anti-goals

- Any owner-visible wiki behavior change: bootstrap preview flow, rollback, rebuild, on-demand ingest, scheduled compile must behave exactly as today.
- Breaking green tests without updating their fixtures to the new (unconstrained) formats.
- New abstraction layers beyond the two named modules (delivery, transcript boundary). This program deletes; it does not add architecture.

## Constraints

- Every step lands with `npm run lint && npm test` green.
- One logical change per commit; Conventional Commits, English, no AI attribution.
- TDD per superpowers: failing test first for each behavior we keep or fix.
- Execution order (each step independently shippable):
  1. Bug fixes (Lockout, deliverTurn)
  2. Wiki recovery collapse
  3. Transcript metadata boundary
  4. Owner delivery module
  5. `app.js` ES-module split

## Current state (review findings, with references)

- `vault/wiki/service.ts` (1015): `settlePrevious` / `settleCommittedBatch` / `recoverCommittedBatch` branch on "X failed but Y already happened"; `pushWithRetry` nests three try/catch levels; `settleRollback` (`service.ts:870-897`) repeats the rollback-trailer validation block twice.
- `vault/wiki/marker.ts` (142): `InFlightMarker` carries a `phase: "writing" | "committed"` and `commit` — a second copy of facts that git trailers already record.
- `vault/wiki/state.ts` (105): `WikiState.lastBatchId`, `lastScanCommit`, `bootstrap`, `rollback`, `resetId` mirror what `reconcile.ts` already derives from history; only backoff/deferral fields are runtime-only.
- `vault/wiki/reconcile.ts` (245): already a read-only derivation of `lastBatchId / bootstrap / rollback / lastScanCommit / preview / reset` from git log trailers. It is the right shape; it is just one of three competing sources today.
- `core/transcript.ts` already classifies every disk record (single read boundary — good), but returns bare `AgentMessage`, so `session.ts` (four sites), `core/history.ts:34`, `index/memory.ts:121` and `context/compaction.ts:65` re-cast `vex*` fields.
- `daemon.ts:144,221,256` plus the outreach session getter hand-roll delivery to the WeChat owner session (`enqueueAssistant` / `injectAssistant` / `send`). Distinct from those, `daemon.ts:199,237` route turns to arbitrary sessions (`tasks` origin delivery, scheduler target delivery via `runToIdle` — scheduler contract: resolves after the delivered turn completes, abort becomes `session.stop()`).
- `gateway/server.ts:67-84 Lockout`: prune only removes expired entries; under sustained multi-address failure the map grows unbounded.
- `channels/wechat/channel.ts:306-311 deliverTurn`: the `interrupted` branch calls `this.send(...)` without the delivery report, so `replyDelivered()` and the trace note claim failure for messages that were actually sent.

## Approaches

### 1. Wiki recovery: git history as the single source of truth

Considered:

- **A. Keep three sources, tighten the code.** Rejected: the complexity *is* the three-way agreement. Polishing the branches keeps the disease.
- **B. Make the state file the single truth; git becomes transport.** Rejected: batch identity, scan bases and rollback relationships are already expressed in commit trailers; a state-truth design still has to reconcile against what actually committed (the same problem, moved), and loses the "the clone describes itself" property that makes crash recovery self-evident.
- **C. (chosen) Git history is the truth; `reconcile()` is the only derivation path.** The marker keeps only what git cannot know (an uncommitted batch in flight). The state file keeps only runtime-only data. Reconciliation stops being "three sources vote" and becomes "read git once".

Why C wins: `reconcile.ts` already derives everything from history; the redundancy is the state file mirroring derived fields and the marker keeping a "committed" phase. Delete the mirrors and the settle branches collapse.

Design details:

- **Marker** (`.git/vex-wiki-inflight.json`) shrinks to `{ batchId, kind, scanBase, baseHead, touched[] }`. No `phase`, no `commit`. It is **removed immediately after a successful commit**. The two crash windows resolve as:
  - marker present + dirty tree → abort/clean per `marker.touched` (today's `abortBatch`, unchanged);
  - commit succeeded, marker still present → `reconcile()` sees the batch trailer, classifies the marker as stale, deletes it; recovery complete, no settle path needed.
- **State file** (`state/wiki.json`) shrinks to `{ failureStreak, nextAttemptAt, lastRunAt, bootstrapDeferred }`. Removed fields (`lastBatchId`, `lastScanCommit`, `bootstrap`, `rollback`, `resetId`) are all derived; the rebuild epoch comes from the `Vex-Wiki-Reset` trailer, which `reconcile.ts` already reads.
- **On-demand idempotent receipt, preserved from git-derived data.** Today a retry of the same source URL while its unpublished batch sits in the marker returns the archived receipt without recompiling (`settleCommittedBatch`, `service.ts:379-385`), and this is a live path — push failure leaves the batch unpublished and the owner retries. With no committed marker, the same check is rebuilt from what reconcile already returns: the newest unpublished batch, its commit's `fingerprintAt(batchSha, rawPath)` compared against the request's source-document hash; a match returns the existing receipt (published or pending as appropriate), a mismatch recompiles. ~30 lines in `service.ts`, no new state.
- **`service.ts` collapse:**
  - `settlePrevious` loses the committed-marker path entirely;
  - `recoverCommittedBatch` is deleted (recovery = run reconcile once);
  - `settleRollback` loses the `state.rollback` branch and its duplicated trailer-validation block becomes one helper;
  - `pushWithRetry` flattens from three nested try/catch into a bounded loop: attempt → fetch/rebase once → attempt, with the "already published HEAD" acceptance kept;
  - `validateCommittedMarker` is deleted with the committed marker phase — its whole job was checking the marker's record against the commit blob; with no committed marker there is nothing to cross-check, and git HEAD itself is the tamper evidence.
- **Migration (unconstrained, and in practice benign):** an old `wiki.json` fails the new parse → treated as absent → reconcile rebuilds from history. An old marker (carrying `phase`) fails the new parse → treated as absent → the next run cleans a dirty tree. Nothing for the owner to do as long as the repository exists; worst case is one re-bootstrap preview.

**Known behavior differences after the collapse** (both owner-visible only in rare failure paths, both deliberate):

1. A push that succeeds while the state-file write fails now reports **published** instead of pending. Today's pending receipt exists because settlement state could disagree with the push; once batch identity lives only in git, a successful push *is* publication and the receipt says so. The test "returns a pending receipt when push succeeds but state settlement fails" is rewritten to assert published.
2. A stale committed marker whose commit blob no longer matches its recorded fingerprints (tamper/repair scenario, guarded by `validateCommittedMarker` today) is no longer blocked by that specific check; the same scenario is caught by the same means as any other foreign history change: `observeWiki` / `assertRecognizedLocalHistory` (integrity gate, unchanged).

Expected size: `vault/wiki` ≈ 2,734 → ≈ 2,200–2,400 lines; `service.ts` 1,015 → ≈ 650.

### 2. Transcript metadata boundary

Considered:

- **A. Change the on-disk record to an envelope `{ message, meta }`.** Rejected: every existing transcript file, plus compaction indexing and memory indexing, would need dual-format readers — churn with zero behavior gain.
- **B. (chosen) Keep the flat JSONL shape; converge every read/write of the `vex*` fields into `core/transcript.ts`** as typed helpers: `transcriptMeta(message)` returning `{ source?, requestId?, notice?, run? }`, plus the write-side annotate/notice helpers. `session.ts`, `memory.ts`, `compaction.ts` lose their casts.

Disk format is unchanged by construction; old files remain readable.

### 3. Owner delivery module

**Scope, stated precisely:** this module covers delivery to the **WeChat owner session** only. The scheduler's `deliver` hook (routes a turn to any target session, resolves when the turn completes, abort becomes `session.stop()`) and the tasks' origin delivery are *turn-driving router logic* inside their respective hooks; folding them in would turn the module into a SessionManager wrapper — new architecture, which this program forbids. They keep their existing closures.

For the owner path: new `src/core/delivery.ts` factory `createOwnerDelivery({ wechatSession })` exposing the three semantics under names that say what they do:

- **queue a runtime notice** (today's `enqueueAssistant`) — fire-and-forget, drained after the current turn settles;
- **inject into the idle transcript** (today's `injectAssistant`) — waits for idle, abortable; the hand-rolled `while (busy)` race is rewritten as a plain deferred promise + abort listener with identical behavior;
- **send an owner-facing message** (today's `send`) — enqueues for the next run.

`daemon.ts`'s wiki `notify`, watchdog `deliver`, heartbeat `deliverHeartbeat` closures collapse into one injected dependency; the outreach check keeps its session getter but uses the module's methods.

### 4. Bug fixes

- **Lockout:** when the map is at capacity, evict the oldest entry regardless of expiry before inserting. The 1024 in the comment becomes true.
- **deliverTurn:** the interrupted branch passes the delivery report, so `replyDelivered()` and the `traces` delivery note reflect reality for every branch.

Both get regression tests first.

### 5. `app.js` ES-module split

Split by surface into native ES modules — `app.js` (entry, WebSocket, shared state), `chat.js`, `schedules.js`, `settings.js`, `files.js`, `traces.js`, plus a small `ui.js` for shared DOM helpers. No bundler, no build step (deliberate project convention preserved). `index.html` already loads `app.js` as `type="module"` (verified), so the browser side only gains real imports.

**Test strategy (the constraint that shapes the split):** `web-app.test.ts` executes the single file in `node:vm` with DOM/WebSocket/timer stubs and asserts against internal bindings (`state.ws`, `handle(...)`). Real module syntax cannot run under `vm.runInContext`, and `vm.SourceTextModule` would force `--experimental-vm-modules` into vitest and CI. Chosen instead: the test gains a small **module loader** that reads each split file, strips one-line `import` statements and rewrites top-level `export` keywords (purely mechanical, our own code style guarantees the shapes), then evals the files in dependency order in one vm context. The browser gets genuine ES modules; the test keeps its current zero-infrastructure strategy and its binding-level assertions. `tsconfig.web.json` includes update; `tests/web-app.test.ts` adapts via the loader.

## What is left to the builder

- Exact internal seams inside `vault/wiki` after the collapse (which helpers live in `service.ts` vs `reconcile.ts`).
- Marker/state test fixture rewrites for the new shapes (formats are unconstrained).
- Final naming of the three delivery methods (semantics fixed above).
- Exact split points and shared-helper placement in `app.js`.

## Verification

- Per step: `npm run lint && npm test` green before moving on.
- Wiki: the 11 `tests/wiki-*.test.ts` suites are updated to the new protocol and green; behavior parity is guarded by `tests/daemon-wiki.test.ts` (integration, scripted models), plus new unit tests for the git-derived idempotent receipt.
- Bugs: new regression tests in `tests/gateway.test.ts` and `tests/wechat-channel.test.ts`.
- Transcript: existing session/memory tests plus new boundary-module unit tests.
- `app.js`: `tests/web-app.test.ts` green and `npm run lint` (which type-checks the browser code via `tsconfig.web.json`) green.
