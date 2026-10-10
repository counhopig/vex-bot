# LLM Wiki for the Notes Vault — Design

**Date:** 2026-10-09
**Status:** Rev 5 — locked transaction, scoped guarantee, recovery boundaries; awaiting re-review
**Scope:** Architectural. Adds a new subsystem, `src/wiki/`, and makes the configured vault writable inside two owned subtrees.

## 1. Problem

Vex can read an Obsidian vault through a read-only git mirror (`vault_search`, `vault_read`), but it never compounds what it reads. Every question re-derives relationships from raw notes, and new sources are not distilled into durable, cross-linked pages.

We want a Karpathy-style LLM wiki inside the owner's Obsidian vault: new and changed notes are periodically compiled into synthesized topic pages, cross-referenced, and queryable with citations — all visible in Obsidian and synced through git.

Reference model: <https://github.com/Astro-Han/karpathy-llm-wiki> (ingest sources into `raw/`, compile durable knowledge into `wiki/`, answer with citations, lint). This design keeps that editorial model but moves the safety-critical mechanics (write boundaries, git, rollback) into tested core code.

## 2. Confirmed Decisions

Constraints chosen during brainstorming:

1. **Vex may write to the vault** — only the `wiki/` and `raw/` subtrees it owns. Every other vault path stays read-only.
2. **Write-back is automatic**: Vex commits and pushes; Obsidian on other devices syncs the result.
3. **Ingest is scheduled**: a built-in periodic run scans the vault for new/changed notes.
4. **On-demand ingest is kept**: the owner can send a link or text and Vex fetches it into `raw/` and compiles it.
5. **All vault notes are sources**: no manual copying into `raw/`; existing notes are compiled in place. `raw/` holds only externally fetched material.
6. **Automatic writes with a safety net**: writes and pushes are automatic; every batch sends a WeChat notification and can be rolled back.
7. **Consumption is both**: browsable in Obsidian and queryable through Vex with citations.
8. **Approach 1 (hybrid)**: safety mechanics in core code, editorial flow in a bundled skill.
9. **Single automatic writer, locked transaction** (finalized after review; supersedes the earlier "reuse `write`/`edit` with a policy allow-list"): the only **automatic** vault writer is the wiki subsystem, through dedicated tools available only inside a locked wiki run. General `write`/`edit` never write the vault. The guarantee is scoped: owner-approved `bash`, MCP, and `delegate` are not constrained by the lock (§9).
10. **Stable batch identity**: every batch commit carries a `Vex-Batch` trailer; state stores batch ids, not raw SHAs, so rebase and state-loss windows are recoverable (§4.8).

## 3. Goals and Non-Goals

**Goals**

- Periodically compile new/changed vault notes into durable topic pages under `<vault>/wiki/`.
- Answer questions from the wiki first, with citations back to pages and source notes.
- Keep the vault's non-wiki content strictly read-only for the automatic write path.
- Make every automated batch one commit, notified and revertible.
- Survive concurrent edits on other devices and crash windows without data loss, duplicate rollbacks, or force pushes.

**Non-goals**

- No web UI for the wiki; Obsidian is the reader.
- No changes to the existing memory index (`memory_search`) or compaction.
- No editing of the owner's pre-existing notes.
- No embeddings/vector store; retrieval stays keyword + link based like the existing vault tools.
- No OS-level sandbox for `bash`/MCP in this design (§9); that is Deferred.

## 4. Architecture

### 4.1 Components

| Component | Change | Responsibility |
|---|---|---|
| `src/vault/git.ts` | Extend | Writable working copy: clone, fetch, rebase, commit, push, path-limited checkout/clean, trailers. Keep the read-only mirror for vault-only setups. |
| `src/vault/notes.ts` | Small change | Read from the shared writable working copy when the wiki is enabled. |
| `src/wiki/` (new) | New | Working copy, lock, batch transaction, in-flight marker, change detection, state file, integrity guard, run orchestration, notifications, bootstrap, rollback, history reconciliation. |
| `src/tools/` (new) | New | Interactive `wiki_ingest`, `wiki_bootstrap`, `wiki_rollback`; run-internal `wiki_write`, `wiki_edit`. |
| `src/policy/policy.ts` | Small change | Vault paths in `write`/`edit` are clamped to deny; no allow-list opens them. |
| `skills/llm-wiki/SKILL.md` (new) | New | Editorial procedure: synthesize topic pages, deduplicate, link, maintain the index, handle deletions, never copy secrets. |
| `src/scheduler/index.ts` | Extend | Bootstrap trigger, `wiki.every` cadence, retry backoff. |
| `src/daemon.ts` | Extend | Open wiki runs (`temporary: "wiki"`) with a restricted toolset; inject the skill body; wire the interactive tools. |
| `src/context/prompt.ts` | Extend | A `## Wiki` section describing tools, layout, and boundaries. |
| `src/config/schema.ts`, `load.ts`, `settings.ts` | Extend | `wiki` configuration and editable settings. |

Layering stays as it is: `src/wiki/` depends on `src/vault/git.ts`; the daemon wires both and injects the shared working copy into `Vault`.

### 4.2 Write path and locked transaction

**Automatic single writer.** The vault's `wiki/` and `raw/` subtrees are written automatically only through `wiki_write`/`wiki_edit`, registered **only** inside a wiki run and bound to those two subtrees. General `write`/`edit` never write the vault. Owner-approved `bash`/MCP/delegate are outside this guarantee and are covered by the integrity guard and attribution rules below, not by the lock (§9).

**One lock per working copy.** The `Wiki` service owns an in-process async mutex. Every wiki run goes through `Wiki.run(kind, task, signal)`:

1. **Acquire the lock.** If busy: an interactive tool reports "wiki run in progress"; a scheduled tick is skipped and retried.
2. **Reconcile state from history** (§4.8) and **settle a pending rollback** (§4.6) first. If the pending rollback cannot be completed, abort and notify; no new batch starts.
3. **Inspect the working tree, before any git sync.** Changes outside `wiki/`/`raw/` are not Vex's: abort and alert. Changes inside `wiki/`/`raw/` are cleaned only when they are **attributable** to an incomplete wiki transaction via the in-flight marker (§4.2.1); unattributable changes are kept and alerted, and the run aborts.
4. **Preview check.** If an unpushed bootstrap preview exists (§4.8), abort and notify; a preview is never auto-pushed.
5. **Fetch.** Then `git rebase origin/<branch>` (the tree is clean by step 3). On conflict: abort the rebase, restore a clean tree, notify, release.
6. **Unpushed normal commits.** If `HEAD` is ahead of `origin/<branch>` after the rebase, try to push. If that fails, keep the commit, abort the run without processing anything, and notify. Batch ids keep the reference stable across the rebase.
7. **Begin.** Record `baseHead = HEAD` and write the in-flight marker.
8. **Run.** Launch a temporary agent run (`temporary: "wiki"`) with the restricted toolset (§7). No `bash`, MCP, network tools, or generic file `read`.
9. **Finalize.** Stage only the paths recorded in the in-flight marker, run the integrity guard and boundary check (§8), commit once with a `Vex-Batch` trailer (unless the bootstrap withholds the push, §4.7), push, advance state, remove the marker, notify.
10. **On failure:** revert only the recorded paths to `baseHead`, remove recorded untracked files, leave everything else, remove the marker, leave state unchanged, notify, release.

**Attribution.** The lock is held for the whole run and only the run's tools write the vault, so every recorded `wiki/`/`raw/` change between steps 7 and 9 belongs to this batch. Because the lock cannot constrain owner-approved `bash`/MCP, attribution is by the in-flight marker, not by path alone.

#### 4.2.1 In-flight marker and attribution

- At begin, write `<git-dir>/vex-wiki-inflight.json` = `{ batchId, baseHead, touched: [] }`.
- Every `wiki_write`/`wiki_edit` appends its target path to `touched` before writing.
- Cleanup may revert to `baseHead` or remove **only** the paths in `touched`. Tracked paths are restored with a path-limited checkout; untracked ones are removed.
- Any `wiki/`/`raw/` change not in `touched`, and any change outside the subtrees, is unattributable: keep it, alert, and abort. This applies at begin, at finalize, and on crash recovery.
- If the marker is missing but the subtrees are dirty, the change is unattributable: keep and alert.

### 4.3 Data flow — scheduled ingest

1. The scheduler runs at the `wiki.every` cadence only when `wiki.enabled` and `bootstrap: done`.
2. It enters `Wiki.run("scheduled", ...)` (§4.2). This kind processes the full diff and **advances the scan cursor**.
3. Change detection computes added/modified/deleted notes since `lastScanCommit` (§6), including previous content for deletions.
4. If nothing changed, the run ends as a **no-output success**: advance `lastScanCommit` to `baseHead` (only if `HEAD == origin/<branch>`, §8), leave `lastBatchId` unchanged, release; no commit, no push, no model call, no notification.
5. Otherwise the changed notes are split into chunks; each chunk is one model call.
6. After the last chunk the run finalizes as in §4.2 step 9.

### 4.4 Data flow — on-demand ingest

1. The owner sends a link, text, or file in WeChat/WebChat.
2. The **main session** fetches or extracts the content (`web_fetch`, or the link-reader skill). The owner is present, so the normal toolset and approvals apply.
3. The main session calls `wiki_ingest({ url?, title?, text })`. `text` carries the extracted content; `url` and `title` are provenance metadata.
4. `wiki_ingest` starts `Wiki.run("on-demand", ...)` with the provided source. This kind **does not advance the scan cursor**; a vault diff that arrived since `lastScanCommit` stays pending for the next scheduled run. The run writes `raw/`, compiles `wiki/`, commits, pushes, notifies, and returns a summary.
5. While `bootstrap: pending`, `wiki_ingest` refuses and tells the owner to approve or reject the first compile.
6. If the session ends before the run finishes, the transaction either commits or aborts per §4.2; no partially-written tree is left unattended (the in-flight marker governs recovery).

### 4.5 Data flow — query

1. The owner asks a question.
2. The agent searches the wiki first (`vault_search` with `folder: "wiki"`), reads matching pages, and answers with citations to wiki pages and, where useful, source notes.
3. If the wiki has nothing, the agent falls back to a full-vault search.

### 4.6 Data flow — rollback

`wiki_rollback` reverts the most recent committed batch exactly once, distinguishing published from unpublished commits. It is refused while `bootstrap: pending`.

1. Acquire the lock; if busy, report "wiki run in progress". Require a clean tree.
2. Resolve `lastBatchId` to a commit (§4.8). If it cannot be resolved uniquely, report and stop.
3. If the batch commit is **not on the remote**: discard it locally (`git reset --hard <parent>`) — **no push** — clear `lastBatchId`, done.
4. If it **is on the remote**: `git revert --no-edit` with a `Vex-Batch` trailer and a `Vex-Revert-Of: <batchId>` trailer. Record `rollback = { targetBatchId, revertId }` in state **before** pushing. Push.
   - On a revert conflict: `git revert --abort`, keep `lastBatchId` and no `rollback`, notify for manual resolution.
   - On push failure: keep the `rollback` state and the local revert commit, notify, and retry later. Never force push.
5. On push success (or already-on-remote), clear `lastBatchId` and `rollback`, and report the resulting commit.
6. A second `wiki_rollback` while `rollback` is pending **completes** the pending rollback instead of creating another revert.
7. Rollback does not move `lastScanCommit`: the rejected compilation is not regenerated until its source notes change again.

### 4.7 Bootstrap

The first full compile is reviewed before Vex may push anything.

- **Trigger.** When `wiki.enabled` is true, `bootstrap` is not `done`, no preview is awaiting review (§4.8), and the retry backoff has elapsed (`now >= nextAttemptAt`, §5.5), the scheduler launches a one-time bootstrap run. The launch is evaluated on the one-second tick but gated by the backoff, so a failure does not produce a retry storm.
- **Run.** The bootstrap run compiles the whole vault in chunks, commits locally with a `Vex-Batch` trailer and a `wiki: bootstrap preview` subject, and withholds the push. It records `lastBatchId` and notifies the owner. `bootstrap` stays `pending`.
- **Empty vault / no changes.** The run ends as a no-output success and immediately sets `bootstrap: done`; there is nothing to review.
- **Approve** (`wiki_bootstrap({ action: "approve" })`): acquire the lock, fetch, and follow §8's rebase/retry rules to push the preview. On a rebase conflict, abort the rebase, keep the preview and `bootstrap: pending`, and notify; never force push. On success, set `bootstrap: done` and arm the cadence. With no pending preview, report that there is nothing to approve.
- **Reject** (`wiki_bootstrap({ action: "reject" })`): acquire the lock and discard the unpublished preview locally (`git reset --hard <parent>`) — **no push** — keeping `bootstrap: pending` so it can be rebuilt. With no pending preview, report that there is nothing to reject.
- While `pending`, `wiki_ingest` and `wiki_rollback` refuse; only `wiki_bootstrap` acts.

### 4.8 Batch identity, preview recognition, and state recovery

**Identity.** Every batch commit's message contains the trailer `Vex-Batch: <uuid>`; the bootstrap preview additionally starts its subject with `wiki: bootstrap preview`; a revert commit adds `Vex-Revert-Of: <uuid>`. State stores batch ids (`lastBatchId`, `rollback.targetBatchId`, `rollback.revertId`), not raw SHAs. SHAs are resolved from history on demand.

**Resolution.** To resolve an id, search both `origin/<branch>..HEAD` (unpublished) and `origin/<branch>` (published):

- **Exactly one match** → that commit, with a published flag.
- **No match** → the commit no longer exists (eliminated by rebase, reset, or it was never created). Clear the corresponding state reference. If a rollback was expected, alert; do not attempt a revert.
- **More than one match** → treat as corruption: abort and alert, take no automatic action.

**Crash and state-loss recovery (reconciliation).** On startup and before every run, reconcile from history:

- Find the newest `Vex-Batch` commit. If state is missing or stale, set `lastBatchId` from it and `bootstrap` to `done` when it is published, or to `pending` when it is an unpublished preview.
- Scan for a revert commit whose `Vex-Revert-Of` trailer references `lastBatchId` or a persisted `rollback.targetBatchId`. If found: published → the rollback is complete, clear `lastBatchId` and `rollback`; unpushed → complete the push. This recovers a revert committed just before a crash, before the rollback state was written. If a persisted `rollback` exists but no revert commit does, the revert was never committed and the rollback may be re-attempted.
- An unpushed commit with the `wiki: bootstrap preview` subject means the preview is awaiting review: `bootstrap: pending`, never auto-pushed.
- No marker and missing state: `bootstrap: pending` with a full scan (conservative).

**Precedence.** Preview protection and pending-rollback completion take precedence over the generic unpushed-commit push (§4.2 step 6) and over the no-output advance (§8).

## 5. Data Model

### 5.1 Vault layout

```
<vault>/
├── wiki/                    # Vex-owned, compiled knowledge
│   ├── _index.md            # map of content: pages grouped by topic, one-line descriptions
│   ├── <topic>.md
│   └── <topic>/...          # subdirectories allowed
├── raw/                     # externally fetched sources
│   └── <date>-<slug>.md
└── ... owner notes (read-only)
```

### 5.2 Topic page format

```markdown
---
title: GIS Patent
tags: [wiki, work]
status: active          # "active"; "orphaned" when every source was deleted
sources:
  - "work/GIS Patent.md"
  - "raw/2026-10-09-some-article.md"
updated: 2026-10-09
---
Synthesized body. Internal links use [[other-topic]]. Source notes are referenced
with relative Markdown links so Obsidian backlinks work.
```

### 5.3 `raw/` source format

```markdown
---
title: Article title
url: https://...
fetched: 2026-10-09
---
Extracted body text.
```

### 5.4 Provenance and deletions

The `sources` frontmatter is the authoritative source-to-page mapping. To find which pages a changed note affects, invert every wiki page's `sources`; no separate mapping is stored.

When a source is deleted:

- The compiler receives the deleted path **and its previous content** (`git show <lastScanCommit>:<path>`).
- The path is removed from every page's `sources`, and the body is updated to drop claims that relied only on it.
- Pages are never deleted automatically. A page that loses all its sources gets `status: orphaned` in frontmatter and is listed in an `_index.md` maintenance section for the owner to keep or remove.

### 5.5 State file

Stored outside the vault at `<data>/state/wiki.json`, never committed:

```json
{
  "lastScanCommit": "<sha>",
  "lastRunAt": 1791542100655,
  "lastBatchId": "<uuid | null>",
  "bootstrap": "pending | done",
  "rollback": { "targetBatchId": "<uuid>", "revertId": "<uuid>" },
  "nextAttemptAt": 1791542400000,
  "failureStreak": 0
}
```

- `lastScanCommit` advances on a successful push, an already-on-remote HEAD, or a no-output batch with nothing unpushed; never on abort, and never for an on-demand run.
- `lastBatchId` is the most recent committed batch (published or a bootstrap preview awaiting review); `null` if none.
- `bootstrap` gates the cadence (§4.7) and is reconciled from history on state loss (§4.8).
- `rollback` is present only while a revert is pending publication (§4.6).
- `nextAttemptAt` / `failureStreak` implement the retry backoff: a failed run increments the streak and sets `nextAttemptAt = now + min(1h, 5m x 2^(streak-1))`; a success resets both. Runs launch only when `now >= nextAttemptAt`.

### 5.6 State lifecycle

- **Missing or partial state while `wiki.enabled`**: reconcile from history (§4.8); default `bootstrap: pending` and a full scan.
- **Disabled** (`wiki.enabled` false): the cadence stops; a pending preview and a pending rollback are retained. Re-enabling resumes the review or completes the rollback first.
- **`lastScanCommit` missing or no longer an ancestor of `HEAD`**: full scan.

### 5.7 Page naming

Topic slugs are stable once created; renaming breaks `[[wikilinks]]`. Aliases go in Obsidian `aliases` frontmatter instead of renaming.

## 6. Change Detection and Chunking

- After syncing, run `git diff --name-status <lastScanCommit>..HEAD -- '*.md'` and parse added/modified/deleted paths.
- Exclude `wiki/` and `raw/` (Vex-owned), hidden directories, and non-Markdown files.
- If `lastScanCommit` is missing or is no longer an ancestor of `HEAD`, fall back to a full scan.
- The diff is split into chunks of at most `wiki.maxNotesPerRun` notes; this bounds **one model call**, and a run processes every chunk and still makes exactly one commit.
- Each deleted path is accompanied by its previous content from `git show <lastScanCommit>:<path>`.
- **Cursor rule.** Only a run that processes the vault diff may advance `lastScanCommit` (`advancesScan`): scheduled and bootstrap runs advance it; on-demand runs do not. This prevents an on-demand ingest from skipping a pending vault change.

## 7. Ingest Execution

- A run's prompt lists the changed notes (or the on-demand source) and embeds the **body of `skills/llm-wiki/SKILL.md`, read and injected by the core**.
- The run toolset is `vault_search`, `vault_read`, `wiki_write`, `wiki_edit`. There is no generic file `read`, no `bash`, no MCP, and no network tool, so a run cannot read configuration or secrets outside the vault.
- The editorial procedure: read changed notes (and deleted-note previous content), identify topics, update or create topic pages, update `_index.md`, add `[[wikilinks]]`, record `sources`, apply the deletion rule, and never copy secret values.
- `wiki_write` overwrites a page; `wiki_edit` makes a targeted replacement. Both reject lexical paths outside `wiki/`/`raw/` and enforce the path-safety rule of §9.
- A failed run leaves state unchanged; the whole diff is retried next attempt. Re-processing compiled notes is idempotent.

## 8. Git Workflow

- The wiki uses a normal clone (not the read-only mirror) checked out on the configured branch, stored under the data directory.
- Ordering, preconditions, in-flight marker, and cleanup are in §4.2.
- **Integrity guard**: before staging, verify `HEAD == baseHead` (no unexpected local commits appeared) and that the only changes are the recorded paths. Any other staged or working-tree change, inside or outside the subtrees, aborts the batch and alerts; nothing unattributable is committed or discarded.
- Stage exactly the recorded `touched` paths, then commit once with message `wiki: ingest <date> (<N> notes, <M> pages)` and the `Vex-Batch: <uuid>` trailer.
- Commit only if there are staged changes; one commit per batch.
- Push. On rejection (non-fast-forward), fetch + rebase + retry up to 2 times. If it still fails, keep the local commit and notify.
- **Already-pushed recovery**: after a push error, `git fetch` and check `git merge-base --is-ancestor HEAD origin/<branch>`; if HEAD is already on the remote, treat the push as successful and advance state.
- **No-output batches** may advance `lastScanCommit` only when `HEAD == origin/<branch>`. If unpushed normal commits remain, push them first; if that fails, do not advance state and notify. An unpushed preview or a pending rollback stops the run instead.
- Never force push.
- Credentials come from `vault.username`/`vault.token` through the environment, as today, but the token needs write scope.

## 9. Boundaries and Security

**Scope of the guarantee.** The lock and single-writer rules cover Vex's **automatic** write path: `wiki_write`/`wiki_edit` inside a locked wiki run, plus `write`/`edit` clamped away from vault paths. Owner-approved `bash`, MCP tools, and `delegate` are `ask` and are **not** constrained by the lock; an approved command can write, commit, or push the working copy. The design **detects** and refuses unattributable state rather than preventing those channels.

**Integrity guard (detection, not prevention).** At lock acquisition and again before commit, `Wiki` compares the working copy with the expected state: remote advances are normal (fetch/rebase handles them); a local commit it did not create, staged changes it did not stage, or working-tree changes outside the recorded `touched` set are anomalies → abort and alert. Because the lock cannot constrain owner-approved channels, this guard cannot guarantee that no concurrent external write happens during a run; it ensures such a write is not silently committed or discarded.

**Path and write safety**

1. **Tool binding**: `wiki_write`/`wiki_edit` are bound to `<vault>/wiki` and `<vault>/raw`.
2. **Root validation**: before any target check, verify that `<vault>/wiki` and `<vault>/raw` are genuine directories at their lexical location — `realpath(root) == lexical root`, with no symlinked component. A root that is a symlink (e.g. `wiki -> ../owner-notes`) aborts the run; containment is never checked against a redirected root.
3. **Target validation at write time**: resolve the target's real path and the real subtree roots (following existing symlinks; for a new path, the nearest existing ancestor, reusing the `resolveRealPath` pattern in `policy.ts`) and reject any target that escapes the subtrees, passes through a directory symlink that escapes, or is a dangling symlink. Abort cleanup cannot restore a file changed outside the subtrees, so this check is primary and the finalize guard is only a backstop.
4. **Policy clamp**: for `write`/`edit`, any vault path is clamped to `deny` and cannot be opened by `tools.policy` overrides. The protected-path check runs before tool overrides.
5. **Staging and guard**: stage only recorded paths; the integrity guard rejects anything else.
6. **Unpublished preview**: a bootstrap commit cannot be pushed except through `wiki_bootstrap({action:"approve"})`.
7. **No generic read**: wiki runs have no generic file `read`; the skill body is injected by the core.

Other rules:

- Note text is untrusted input. The automatic-writer boundary, the restricted run toolset, and path validation are the primary mitigations.
- Wiki pages must not reproduce credentials, tokens, passwords, or secret values; an optional exclusion list for sensitive notes is Deferred.
- `wiki_write`/`wiki_edit` exist only inside wiki runs; a normal session cannot obtain them.
- The existing `vault_read`/`vault_search` tools remain, now reading the shared working copy.

## 10. Tools, Prompt, Scheduler, Configuration

**Interactive tools** (registered in normal sessions when the wiki is enabled)

| Tool | Parameters | Behaviour |
|---|---|---|
| `wiki_ingest` | `{ url?, title?, text }` | Start a locked on-demand wiki run with the extracted source; does not advance the scan cursor; return a summary. Refused while the bootstrap is pending. |
| `wiki_bootstrap` | `{ action: "approve" \| "reject" }` | Approve: push the preview, set `bootstrap: done`, arm the cadence. Reject: discard the unpublished preview locally, keep `pending`. |
| `wiki_rollback` | none | Revert the most recent committed batch exactly once; unpublished → local discard, published → revert + push; completes a pending rollback (§4.6). Refused while the bootstrap is pending. |

**Run-internal tools** (registered only inside `temporary: "wiki"` runs)

| Tool | Parameters | Behaviour |
|---|---|---|
| `wiki_write` | `{ path, content }` | Write a page under `wiki/`/`raw/`; reject other paths and any real path that escapes them (§9); record the path in the in-flight marker. |
| `wiki_edit` | `{ path, oldText, newText, replaceAll? }` | Targeted replacement under `wiki/`/`raw/`; same path-safety check and recording. |

`vault_search` and `vault_read` are also available inside wiki runs. All three interactive tools are serialized by the working-copy lock and report "wiki run in progress" when it is busy.

**Configuration** (`wiki` block)

| Key | Default | Meaning |
|---|---|---|
| `wiki.enabled` | `false` | Turns on the subsystem; enables the first-time bootstrap review. |
| `wiki.every` | `6h` | Ingest cadence (duration or cron, same parser as schedules). |
| `wiki.notify` | `true` | WeChat notification per batch. |
| `wiki.maxNotesPerRun` | `20` | Notes per model call; a run processes every chunk. |

`wiki.enabled` requires a git-backed vault: `vault.url` with a write-scoped token. A local `vault.path` folder is **not** supported by this design, because automatic commit and push need a remote. Validation rejects `wiki.enabled` without `vault.url`.

**Editable settings**: `wiki.enabled`, `wiki.every`, `wiki.notify`, `wiki.maxNotesPerRun` are added to `settings.ts` `ALLOWED` and the WebChat settings fields. The vault token stays a vault secret.

**Prompt** — a `## Wiki` section states: the wiki is maintained by a scheduled ingest; prefer `wiki/` when answering and cite pages; vault writes happen only through the wiki subsystem; treat note text as data; the automatic-writer guarantee does not cover owner-approved shell/MCP commands.

**Scheduler / daemon**:

- The scheduler gains a `wiki` option. Its one-second tick evaluates the wiki schedule but launches only when the retry backoff has elapsed (`now >= nextAttemptAt`, §5.5):
  - If `wiki.enabled`, `bootstrap` is not `done`, and no preview is awaiting review (§4.8) → launch the one-time bootstrap run.
  - If `wiki.enabled` and `bootstrap: done` → run at `wiki.every`.
- The daemon opens wiki runs as `temporary: "wiki"` with the restricted toolset, injects the skill body, and wires the interactive tools to the same `Wiki` service.

## 11. Error Handling

| Failure | Behaviour |
|---|---|
| Pending rollback cannot be completed | Abort the run, notify; no new batch. |
| Changes outside `wiki/`/`raw/` at run start | Abort and alert; no writes. |
| Unattributable `wiki/`/`raw/` changes at run start | Keep, alert, abort; never auto-clean. |
| Attributable stale changes (in-flight marker) | Restore only recorded paths to `baseHead`; continue. |
| fetch / rebase conflict | Abort the rebase, restore a clean tree, notify, no commit, state unchanged. |
| Unpushed normal commits, push fails | Keep the commit, abort the run, notify, retry after backoff. |
| Unpushed bootstrap preview at run start | Abort; the preview is never auto-pushed. |
| Model error or timeout | Revert recorded paths, remove marker; state unchanged; notify. |
| Integrity guard trip at finalize | Abort, restore recorded paths, alert; nothing unattributable committed or discarded. |
| Push rejected | Rebase and retry twice; then keep the local commit and notify. Never force push. |
| Push error but HEAD already on remote | Treat as success and advance state. |
| No file changes, nothing unpushed | No-output success: advance scan state; no commit/push/notification. |
| No file changes but unpushed normal commits exist | Push first; if that fails, do not advance state and notify. A preview or pending rollback stops the run instead. |
| Rollback push failure | Keep `rollback` state and the local revert, notify; complete before any new batch; a second call completes, never re-reverts. |
| Batch id not found / multiple matches | No match: clear the reference, alert if a rollback was expected. Multiple: abort, alert, no automatic action. |
| Bootstrap/model failure | Back off (`nextAttemptAt`); notify at most once per backoff step. |
| Lock busy | Interactive tool reports "wiki run in progress"; scheduled tick retries later. |
| Path-safety rejection (symlink/`..`/root) | Reject before writing; report to the run. |

Every terminal outcome sends a WeChat notification when `wiki.notify` is on, except no-output successes.

## 12. Testing

**Unit**

- Writable repo: clone/fetch/rebase/commit/push against a local bare repository; conflict aborts without side effects; path-limited checkout/clean; trailers.
- Lock: concurrent runs serialize; a busy lock makes interactive tools report and scheduled ticks skip.
- Attribution: attributable stale changes are restored; unattributable `wiki/`/`raw/` and out-of-subtree changes are kept and abort the run; missing marker with a dirty tree keeps changes.
- Integrity guard: a commit or staged change the service did not create aborts; remote advances do not.
- Change detection: added/modified/deleted, subtree exclusions, non-ancestor fallback, first-run full scan.
- Chunking: N+1 notes with `maxNotesPerRun = N` produce two model calls and exactly one commit.
- Cursor: an on-demand ingest does not advance `lastScanCommit`; a pending vault change is processed by the next scheduled run.
- State: advances on successful push, already-on-remote HEAD, and a no-output batch with nothing unpushed; never with unpushed commits, on abort, or after on-demand.
- Deletion: previous content is supplied; `sources` is cleaned; a page losing all sources becomes `orphaned` and is listed in `_index.md`; no page is deleted.
- Policy: vault paths in `write`/`edit` are denied and overrides cannot open them.
- Path safety: root symlink (`wiki -> ../owner-notes`), file symlink, directory symlink, dangling symlink, and `..` bypass are rejected before any write.
- Run toolset: contains `wiki_write`/`wiki_edit` and excludes `bash`, MCP, and generic `read`; a normal session's toolset does not contain the wiki write tools.
- Bootstrap: the one-time trigger fires once; no-change completes `done`; approve pushes; reject discards locally and never pushes.
- Batch identity: id resolution with zero/one/multiple matches; rebase changes the SHA but the id still resolves; state-write failure recovers from the trailer.
- Rollback: unpublished commit → local discard without push; published commit → revert + push; a push failure then a second call completes instead of re-reverting; a revert committed before the state write is recovered from the `Vex-Revert-Of` trailer; conflict aborts cleanly.
- Backoff: consecutive failures space retries by `min(1h, 5m x 2^(streak-1))` and reset on success.
- State lifecycle: missing state behaves as `pending`; disable/enable resumes correctly.

**Integration**

- A scheduled ingest with a fake agent produces exactly one commit and one notification.
- An on-demand `wiki_ingest` produces one commit, does not advance the cursor, and leaves no dirty tree.
- A guard violation aborts the batch.

**Existing suites**

- `tests/vault*.test.ts`, `tests/policy.test.ts`, scheduler and daemon tests need updates because the vault is no longer strictly read-only when the wiki is enabled.

## 13. Risks, Resolved Items, Deferred

**Risks**

- Synthesis quality: LLM-generated pages may be wrong or noisy. Mitigation: provenance frontmatter, bootstrap review, and rollback.
- Prompt injection: mitigated by the automatic-writer boundary, the restricted run toolset (no generic `read`), and path validation.
- Owner-approved `bash`/MCP: outside the lock; the integrity guard detects unattributable state but cannot prevent concurrent external writes during a run.
- Owner editing `wiki/` on another device: a rebase conflict aborts the run and notifies; the owner's edit wins because Vex abandons the run.
- Cost: the first full compile is expensive. Mitigation: chunked runs and the bootstrap review.

**Resolved after review**

- Guarantee scoped to the automatic write path; owner-approved channels are explicitly outside the lock and covered by detection.
- Integrity guard plus attribution: only in-flight-recorded paths are auto-cleaned; unattributable changes are kept and alerted, at begin and finalize.
- On-demand ingest does not advance the scan cursor.
- Rollback is a single-execution state machine with pending-publication recovery.
- Batch ids in commit trailers survive rebase and state-loss windows; zero/one/multiple resolutions are defined.
- Dirty-tree inspection happens before fetch/rebase, so crash leftovers cannot block recovery.
- Wiki runs have no generic file `read`; the skill body is injected by the core.
- Subtree roots are validated as real directories before target checks.
- Deleted sources keep previous content, clean `sources`, and mark pages `orphaned`.
- Retry backoff prevents per-tick failure storms.

**Deferred** (not in this design)

- OS-level sandboxing of `bash`/MCP to make the write boundary absolute.
- Supporting a local `vault.path` folder as a wiki source.
- Merging concurrent owner edits inside `wiki/` instead of aborting.
- An exclusion list for sensitive notes (e.g. password notes) beyond the no-secrets instruction.
- Forcing a recompile of notes after a rollback.

## 14. Milestones

1. Writable git working copy + single-automatic-writer boundary (`wiki_write`/`wiki_edit`, policy clamp, root/path safety).
2. `Wiki.run` transaction: lock, in-flight marker, attribution/cleanup, integrity guard, change detection, state file, commit/push.
3. Batch identity + history reconciliation (trailers, zero/one/multiple, crash recovery).
4. Scheduler cadence + bootstrap trigger/approve/reject + retry backoff.
5. `wiki_ingest` (cursor-safe) and `wiki_rollback` (single-execution state machine).
6. Wiki run toolset + injected `skills/llm-wiki/SKILL.md` + prompt section.
7. Config, editable settings, docs, and full test coverage update.
