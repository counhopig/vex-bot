# LLM Wiki for the Notes Vault — Design

**Date:** 2026-10-09
**Status:** Rev 6 — phased transaction, operation identity, scan-boundary recovery; awaiting re-review
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
9. **Single automatic writer, locked transaction** (supersedes the earlier "reuse `write`/`edit` with a policy allow-list"): the only **automatic** vault writer is the wiki subsystem, through dedicated tools inside a locked wiki run. General `write`/`edit` never write the vault. Owner-approved `bash`, MCP, and `delegate` are not constrained by the lock (§9).
10. **Durable transaction state**: batch/rollback identity, the transaction phase, write fingerprints, and the scan boundary live in durable git trailers and an in-flight marker, so every crash window is recoverable (§4.8).

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
- No OS-level sandbox for `bash`/MCP in this design (§9); Deferred.

## 4. Architecture

### 4.1 Components

| Component | Change | Responsibility |
|---|---|---|
| `src/vault/git.ts` | Extend | Writable working copy: clone, fetch, rebase, commit, push, path-limited checkout/clean, trailers. Keep the read-only mirror for vault-only setups. |
| `src/vault/notes.ts` | Small change | Read from the shared writable working copy when the wiki is enabled. |
| `src/wiki/` (new) | New | Working copy, lock, phased batch transaction, in-flight marker, change detection, state file, integrity guard, run orchestration, notifications, bootstrap, rollback, history reconciliation. |
| `src/tools/` (new) | New | Interactive `wiki_ingest`, `wiki_bootstrap`, `wiki_rollback`; run-internal `wiki_write`, `wiki_edit`. |
| `src/policy/policy.ts` | Small change | Vault paths in `write`/`edit` are clamped to deny; no allow-list opens them. |
| `skills/llm-wiki/SKILL.md` (new) | New | Editorial procedure: synthesize topic pages, deduplicate, link, maintain the index, handle deletions, never copy secrets. |
| `src/scheduler/index.ts` | Extend | Bootstrap trigger, `wiki.every` cadence, retry backoff. |
| `src/daemon.ts` | Extend | Open wiki runs (`temporary: "wiki"`) with a restricted toolset; inject the skill body; wire the interactive tools. |
| `src/context/prompt.ts` | Extend | A `## Wiki` section describing tools, layout, and boundaries. |
| `src/config/schema.ts`, `load.ts`, `settings.ts` | Extend | `wiki` configuration and editable settings. |

Layering stays as it is: `src/wiki/` depends on `src/vault/git.ts`; the daemon wires both and injects the shared working copy into `Vault`.

### 4.2 Write path and locked transaction

**Automatic single writer.** The vault's `wiki/` and `raw/` subtrees are written automatically only through `wiki_write`/`wiki_edit`, available **only** inside a wiki run and bound to those subtrees. General `write`/`edit` never write the vault. Owner-approved `bash`/MCP/delegate are outside this guarantee and are covered by the integrity guard and attribution rules below, not by the lock (§9).

**One lock per working copy.** The `Wiki` service owns an in-process async mutex. Every wiki run goes through `Wiki.run(kind, task, signal)`:

1. **Acquire the lock.** If busy: an interactive tool reports "wiki run in progress"; a scheduled tick is skipped and retried.
2. **Fetch** (`git fetch`, read-only, does not touch the working tree) so remote-tracking refs are fresh before any decision about published state.
3. **Reconcile from history** with the fresh refs (§4.8): recover batch identity, phase, scan boundary, and any pending rollback. If the in-flight marker's `batchId` already has a commit, the batch committed: mark the marker `committed` and record that commit. A committed batch is never restored from files.
4. **Inspect the working tree and clean attributable leftovers (writing phase only).** Changes outside `wiki/`/`raw/` are not Vex's: abort and alert. Changes inside the subtrees are cleaned only when the marker is in the `writing` phase and each path still matches its recorded fingerprint (§4.2.1); anything else is kept and alerted, and the run aborts.
5. **Settle a pending rollback** (§4.6). If it cannot be completed, abort and notify; no new batch starts. This is after the fetch and integrity checks.
6. **Preview check.** If an unpushed bootstrap preview exists, abort and notify; a preview is never auto-pushed.
7. **Rebase** onto `origin/<branch>` (the tree is clean by step 3). On conflict: abort the rebase, restore a clean tree, notify, release.
8. **Unpushed normal commits.** If `HEAD` is ahead of `origin/<branch>` after the rebase, try to push. If that fails, keep the commit, abort the run without processing anything, and notify.
9. **Begin.** Record `baseHead = HEAD` and write the in-flight marker with `phase: "writing"`.
10. **Run.** Launch a temporary agent run (`temporary: "wiki"`) with the restricted toolset (§7). No `bash`, MCP, network tools, or generic file `read`.
11. **Finalize.** Stage only the recorded paths, run the integrity guard and boundary check (§8), commit once with the batch trailers, mark the marker `committed`, push, advance state, remove the marker, notify.
12. **Failure before commit**: restore only recorded paths that still match their recorded fingerprint, remove recorded untracked files, remove the marker, leave state unchanged, notify.
13. **Failure after commit**: keep the commit and the marker (`phase: "committed"`), notify, and let the next reconciliation complete publication. Files are never rolled back after a commit.

### 4.2.1 In-flight marker: fingerprints, attribution, and phase

At begin, write `<git-dir>/vex-wiki-inflight.json`:

```json
{
  "batchId": "<uuid>",
  "kind": "scheduled | bootstrap | on-demand",
  "advancesScan": true,
  "scanBase": "<sha | null>",
  "baseHead": "<sha>",
  "phase": "writing | committed",
  "commit": "<sha | null>",
  "touched": [
    { "path": "wiki/a.md", "before": { "type": "absent | file", "hash": "<sha256>" },
      "after": { "type": "file", "hash": "<sha256>" } }
  ]
}
```

- `wiki_write`/`wiki_edit` record the target's `before` (type and content hash) and `after` (type and hash) before returning.
- **Attribution is by fingerprint, not by path.** At cleanup or finalize, a `touched` path is attributable only if its **current** type and hash equal its recorded `after`. If it changed again (for example, an owner-approved `bash` edited the same file), the path is unattributable: keep it, alert, and abort. It is never silently committed or discarded.
- Cleanup reverts exactly the attributable recorded paths to `baseHead` (tracked) or removes them (untracked). Nothing else is touched.
- The marker is updated to `phase: "committed"` with the new `commit` SHA in the same step as the git commit, before any push.
- A missing marker with a dirty subtree means the change is unattributable: keep and alert.

### 4.2.2 Transaction phases

| Phase | Meaning | Allowed actions on failure |
|---|---|---|
| `writing` | Files are being written; no commit yet. | Restore attributable recorded paths; remove marker. |
| `committed` | The batch commit exists; not necessarily pushed. | Keep the commit and marker; retry publication. **Never** roll back files. |
| published | The commit is on `origin/<branch>`. | Advance state, remove marker, notify. |

Only the `writing` phase permits file restoration. A push failure, a state-write failure, or a notification failure after the commit leaves the commit in place and the marker `committed`; reconciliation completes it. This prevents a post-commit failure from producing a dirty tree against a committed HEAD.

### 4.3 Data flow — scheduled ingest

1. The scheduler runs at the `wiki.every` cadence only when `wiki.enabled` and `bootstrap: done`.
2. It enters `Wiki.run("scheduled", ...)` (§4.2). This kind processes the full diff and **advances the scan cursor**.
3. Change detection computes added/modified/deleted notes since `lastScanCommit` (§6), including previous content for deletions. `scanBase` is the pre-run `HEAD`; `advancesScan` is true.
4. If nothing changed, the run ends as a **no-output success**: advance `lastScanCommit` to `scanBase` (only if `HEAD == origin/<branch>`, §8), leave `lastBatchId` unchanged, release; no commit, no push, no model call, no notification.
5. Otherwise the changed notes are split into chunks; each chunk is one model call.
6. After the last chunk the run finalizes as in §4.2 step 11.

### 4.4 Data flow — on-demand ingest

1. The owner sends a link, text, or file in WeChat/WebChat.
2. The **main session** fetches or extracts the content (`web_fetch`, or the link-reader skill). The owner is present, so the normal toolset and approvals apply.
3. The main session calls `wiki_ingest({ url?, title?, text })`.
4. `wiki_ingest` starts `Wiki.run("on-demand", ...)` with the provided source. This kind has `advancesScan: false` and `scanBase: null`: it **does not move the scan cursor**, so a vault diff that arrived since `lastScanCommit` stays pending for the next scheduled run. The run writes `raw/`, compiles `wiki/`, commits, pushes, notifies, and returns a summary.
5. While `bootstrap: pending`, `wiki_ingest` refuses and tells the owner to approve or reject the first compile.
6. If the session ends before the run finishes, the transaction either commits or aborts per §4.2; the in-flight marker governs recovery.

### 4.5 Data flow — query

1. The owner asks a question.
2. The agent searches the wiki first (`vault_search` with `folder: "wiki"`), reads matching pages, and answers with citations to wiki pages and, where useful, source notes.
3. If the wiki has nothing, the agent falls back to a full-vault search.

### 4.6 Data flow — rollback

`wiki_rollback` reverts the most recent committed compile batch exactly once. It is refused while `bootstrap: pending`.

1. Acquire the lock; if busy, report "wiki run in progress".
2. **Fetch and run the integrity guard before any destructive step.** Require a clean tree.
3. Resolve `lastBatchId` to a commit (§4.8). If it cannot be resolved uniquely, report and stop.
4. Re-evaluate the published status **against the freshly fetched remote ref**.
   - **Unpublished**: discard locally **only if the target is the local tip** (`HEAD == target`, i.e. no commit we must keep follows it). Then `git reset --hard <parent>`, clear `lastBatchId`, done. If the target is not the tip, keep it and alert instead of resetting.
   - **Published**: `git revert --no-edit` with a rollback identity and `Vex-Revert-Of: <batchId>` trailers. Record `rollback = { targetBatchId, revertId }` in state **before** pushing. Push.
     - Revert conflict: `git revert --abort`, keep `lastBatchId`, no pending `rollback`, notify.
     - Push failure: keep the `rollback` state and the local revert commit, notify, retry later. Never force push.
5. On push success (or already-on-remote), clear `lastBatchId` and `rollback`, and report the resulting commit.
6. A second `wiki_rollback` while `rollback` is pending **completes** the pending rollback instead of creating another revert.
7. Rollback does not move `lastScanCommit`; the rejected compilation is not regenerated until its sources change again.

### 4.7 Bootstrap

The first full compile is reviewed before Vex may push anything.

- **Trigger.** When `wiki.enabled` is true, `bootstrap` is not `done`, no preview is awaiting review, and the retry backoff has elapsed (`now >= nextAttemptAt`, §5.5), the scheduler launches a one-time bootstrap run. The launch is evaluated on the one-second tick but gated by the backoff.
- **Run.** The bootstrap run compiles the whole vault in chunks, commits locally with the batch trailers and a `wiki: bootstrap preview` subject, and withholds the push. It records `lastBatchId` and notifies the owner. `bootstrap` stays `pending`.
- **Empty vault / no changes.** No-output success; immediately set `bootstrap: done`.
- **Approve** (`wiki_bootstrap({ action: "approve" })`): acquire the lock, fetch, run the integrity guard, and follow §8's rebase/retry to push the preview. On rebase conflict, abort the rebase, keep the preview and `bootstrap: pending`, notify; never force push. On success, set `bootstrap: done` and arm the cadence. With no pending preview, report that there is nothing to approve.
- **Reject** (`wiki_bootstrap({ action: "reject" })`): acquire the lock, **fetch first and re-verify against the fresh remote ref that the preview is still unpublished**. If it is now published, do not reset; report that it was approved and mark `bootstrap: done`. If still unpublished **and the preview is the local tip**, discard it locally (`git reset --hard <parent>`) — no push — keeping `bootstrap: pending`. If the preview is not the tip, keep it and alert. With no pending preview, report that there is nothing to reject.
- While `pending`, `wiki_ingest` and `wiki_rollback` refuse; only `wiki_bootstrap` acts.

### 4.8 Durable identity, reconciliation, and scan recovery

**Identity and trailers.** Compile batches carry `Vex-Batch: <uuid>`, `Vex-Kind: scheduled|bootstrap|on-demand`, and `Vex-Scan-Base: <sha|none>`; a bootstrap preview also starts its subject with `wiki: bootstrap preview`. Rollback commits carry `Vex-Rollback: <uuid>` and `Vex-Revert-Of: <batchId>` and **no `Vex-Batch`**, so a rollback is never mistaken for a compile batch. State stores ids, not SHAs.

**Resolution** (after a fetch, searching both `origin/<branch>..HEAD` and `origin/<branch>`):

- **Exactly one match** → that commit, with a published flag.
- **No match** → the commit was eliminated (rebase/reset/never created): clear the reference; if a rollback was expected, alert; do not revert.
- **More than one match** → corruption: abort and alert, take no automatic action.

**Reconciliation procedure** (startup and before every run, with fresh refs):

1. Resolve the in-flight marker against history: if a commit with the marker's `Vex-Batch` id exists, the batch is committed — set the marker `committed`, record the commit, and never restore its files.
2. Enumerate **compile batches** (commits with `Vex-Batch`) and **rollbacks** (commits with `Vex-Rollback`/`Vex-Revert-Of`). Rollbacks are never candidates for `lastBatchId`.
3. Determine the newest compile batch `B_new`.
   - If a rollback commit references `B_new`: published → the rollback is complete, clear `lastBatchId`; unpushed → complete the push, then clear. `B_new` is not offered for reverting again.
   - Else if `B_new` is an unpublished preview → `bootstrap: pending`, `lastBatchId = B_new`.
   - Else → `lastBatchId = B_new`.
   - With no compile batch, `lastBatchId = null` and `bootstrap: pending`.
4. Recover a revert committed just before a crash: if a `Vex-Rollback` commit references `lastBatchId` or a persisted `rollback.targetBatchId`, treat the rollback as executed (complete its push if unpushed) and clear, even if the `rollback` state was never written.
5. Recover the **scan cursor** from `Vex-Scan-Base` of compile batches that have `Vex-Kind` of `scheduled` or `bootstrap`, taking the boundary of the newest such batch. **Never** use the rebased parent commit, which may contain uncompiled sources. An `on-demand` batch has no scan base and never moves the cursor. Reverted batches keep their scan base, so a rollback does not make the same sources recompile.
6. If no scan base is recoverable and the state is missing, fall back to a full scan.

**Precedence.** Preview protection and pending-rollback completion take precedence over the generic unpushed-commit push (§4.2 step 8) and over the no-output advance (§8).

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

- `lastScanCommit` advances on a successful publish of a run with `advancesScan`, or a no-output batch with nothing unpushed; never on abort, and never for an on-demand run.
- `lastBatchId` is the most recent committed **compile** batch (published or an unpublished preview awaiting review); `null` if none or after a rollback.
- `bootstrap` gates the cadence (§4.7) and is reconciled from history on state loss (§4.8).
- `rollback` is present only while a revert is pending publication (§4.6).
- `nextAttemptAt` / `failureStreak` implement the retry backoff: a failed run increments the streak and sets `nextAttemptAt = now + min(1h, 5m x 2^(streak-1))`; a success resets both. Runs launch only when `now >= nextAttemptAt`.

### 5.6 State lifecycle

- **Missing or partial state while `wiki.enabled`**: reconcile from history (§4.8); default `bootstrap: pending` and a full scan.
- **Disabled** (`wiki.enabled` false): the cadence stops; a pending preview and a pending rollback are retained. Re-enabling settles the rollback and resumes the review first.
- **`lastScanCommit` missing or no longer an ancestor of `HEAD`**: full scan.

### 5.7 Page naming

Topic slugs are stable once created; renaming breaks `[[wikilinks]]`. Aliases go in Obsidian `aliases` frontmatter instead of renaming.

## 6. Change Detection and Chunking

- After syncing, run `git diff --name-status <lastScanCommit>..HEAD -- '*.md'` and parse added/modified/deleted paths.
- Exclude `wiki/` and `raw/` (Vex-owned), hidden directories, and non-Markdown files.
- If `lastScanCommit` is missing or is no longer an ancestor of `HEAD`, fall back to a full scan.
- The diff is split into chunks of at most `wiki.maxNotesPerRun` notes; this bounds **one model call**, and a run processes every chunk and still makes exactly one commit.
- Each deleted path is accompanied by its previous content from `git show <lastScanCommit>:<path>`.
- **Cursor rule.** Only a run with `advancesScan` may advance `lastScanCommit`, and it records its `scanBase` in the commit trailers so recovery can reconstruct the cursor without using a rebased parent.

## 7. Ingest Execution

- A run's prompt lists the changed notes (or the on-demand source) and embeds the **body of `skills/llm-wiki/SKILL.md`, read and injected by the core**.
- The run toolset is `vault_search`, `vault_read`, `wiki_write`, `wiki_edit`. There is no generic file `read`, no `bash`, no MCP, and no network tool, so a run cannot read configuration or secrets outside the vault.
- The editorial procedure: read changed notes (and deleted-note previous content), identify topics, update or create topic pages, update `_index.md`, add `[[wikilinks]]`, record `sources`, apply the deletion rule, and never copy secret values.
- `wiki_write` overwrites a page; `wiki_edit` makes a targeted replacement. Both reject lexical paths outside `wiki/`/`raw/`, enforce the path-safety rule of §9, and record fingerprints.
- A failed run leaves state unchanged; the whole diff is retried next attempt. Re-processing compiled notes is idempotent.

## 8. Git Workflow

- The wiki uses a normal clone (not the read-only mirror) checked out on the configured branch, stored under the data directory.
- Ordering, preconditions, in-flight marker, and cleanup are in §4.2.
- **Integrity guard**: before staging, verify `HEAD == baseHead` (no unexpected local commits appeared) and that each `touched` path still matches its recorded `after` fingerprint. Any other staged or working-tree change, inside or outside the subtrees, or any fingerprint mismatch, aborts the batch and alerts; nothing unattributable is committed or discarded.
- Stage exactly the recorded `touched` paths, then commit once with message `wiki: ingest <date> (<N> notes, <M> pages)` and the trailers `Vex-Batch`, `Vex-Kind`, `Vex-Scan-Base`.
- Commit only if there are staged changes; one commit per batch. Immediately update the in-flight marker to `committed` with the commit SHA.
- Push. On rejection (non-fast-forward), fetch + rebase + retry up to 2 times. If it still fails, keep the local commit and marker, notify; the next reconciliation completes it.
- **Already-pushed recovery**: after a push error, `git fetch` and check `git merge-base --is-ancestor HEAD origin/<branch>`; if HEAD is already on the remote, treat the push as successful, advance state, and remove the marker.
- **No-output batches** may advance `lastScanCommit` only when `HEAD == origin/<branch>`. If unpushed normal commits remain, push them first; if that fails, do not advance state and notify. An unpushed preview or a pending rollback stops the run instead.
- Never force push.
- Credentials come from `vault.username`/`vault.token` through the environment, as today, but the token needs write scope.

## 9. Boundaries and Security

**Scope of the guarantee.** The lock and single-writer rules cover Vex's **automatic** write path: `wiki_write`/`wiki_edit` inside a locked wiki run, plus `write`/`edit` clamped away from vault paths. Owner-approved `bash`, MCP, and `delegate` are `ask` and are **not** constrained by the lock; an approved command can write, commit, or push the working copy. The design **detects** and refuses unattributable state rather than preventing those channels. A check-then-act race between the guard and the actual operation cannot be eliminated under this scope.

**Integrity guard (detection, not prevention).** At fetch time, at lock acquisition, and again before commit, `Wiki` compares the working copy with the expected state: remote advances are normal (fetch/rebase handles them); a local commit it did not create, staged changes it did not stage, a working-tree change outside the recorded `touched` set, or a fingerprint mismatch is an anomaly → abort and alert. This ensures an owner-approved external write is not silently committed or discarded. It cannot guarantee that no concurrent external write happens between a check and the operation.

**Path and write safety**

1. **Tool binding**: `wiki_write`/`wiki_edit` are bound to `<vault>/wiki` and `<vault>/raw`.
2. **Root validation**: before any target check, verify that `<vault>/wiki` and `<vault>/raw` are genuine directories at their lexical location — `realpath(root) == lexical root`, with no symlinked component. A root that is a symlink (e.g. `wiki -> ../owner-notes`) aborts the run; containment is never checked against a redirected root.
3. **Target validation at write time**: resolve the target's real path and the real subtree roots (following existing symlinks; for a new path, the nearest existing ancestor, reusing the `resolveRealPath` pattern in `policy.ts`) and reject any target that escapes the subtrees, passes through a directory symlink that escapes, or is a dangling symlink. Abort cleanup cannot restore a file changed outside the subtrees, so this check is primary and the finalize guard is only a backstop.
4. **Fingerprint attribution**: only paths whose current content matches the recorded `after` fingerprint may be staged or cleaned.
5. **Policy clamp**: for `write`/`edit`, any vault path is clamped to `deny` and cannot be opened by `tools.policy` overrides.
6. **Unpublished preview**: a bootstrap commit cannot be pushed except through `wiki_bootstrap({action:"approve"})`, and reject re-verifies unpublished status after a fetch.
7. **No generic read**: wiki runs have no generic file `read`; the skill body is injected by the core.

Other rules:

- Note text is untrusted input. The automatic-writer boundary, the restricted run toolset, fingerprint attribution, and path validation are the primary mitigations.
- Wiki pages must not reproduce credentials, tokens, passwords, or secret values; an optional exclusion list for sensitive notes is Deferred.
- `wiki_write`/`wiki_edit` exist only inside wiki runs; a normal session cannot obtain them.
- The existing `vault_read`/`vault_search` tools remain, now reading the shared working copy.

## 10. Tools, Prompt, Scheduler, Configuration

**Interactive tools** (registered in normal sessions when the wiki is enabled)

| Tool | Parameters | Behaviour |
|---|---|---|
| `wiki_ingest` | `{ url?, title?, text }` | Start a locked on-demand wiki run with the extracted source; `advancesScan: false`; return a summary. Refused while the bootstrap is pending. |
| `wiki_bootstrap` | `{ action: "approve" \| "reject" }` | Approve: push the preview, set `bootstrap: done`, arm the cadence. Reject: fetch and re-verify unpublished, then discard only if it is the local tip; otherwise keep and alert. |
| `wiki_rollback` | none | Revert the most recent committed compile batch exactly once; fetch + integrity guard first; unpublished discard only when it is the local tip; published → revert + push; completes a pending rollback. Refused while the bootstrap is pending. |

**Run-internal tools** (registered only inside `temporary: "wiki"` runs)

| Tool | Parameters | Behaviour |
|---|---|---|
| `wiki_write` | `{ path, content }` | Write a page under `wiki/`/`raw/`; reject other paths and any real path that escapes them (§9); record before/after fingerprints. |
| `wiki_edit` | `{ path, oldText, newText, replaceAll? }` | Targeted replacement under `wiki/`/`raw/`; same path safety and fingerprint recording. |

`vault_search` and `vault_read` are also available inside wiki runs. All three interactive tools are serialized by the working-copy lock and report "wiki run in progress" when it is busy.

**Configuration** (`wiki` block)

| Key | Default | Meaning |
|---|---|---|
| `wiki.enabled` | `false` | Turns on the subsystem; enables the first-time bootstrap review. |
| `wiki.every` | `6h` | Ingest cadence (duration or cron, same parser as schedules). |
| `wiki.notify` | `true` | WeChat notification per batch. |
| `wiki.maxNotesPerRun` | `20` | Notes per model call; a run processes every chunk. |

`wiki.enabled` requires a git-backed vault: `vault.url` with a write-scoped token. A local `vault.path` folder is **not** supported by this design. Validation rejects `wiki.enabled` without `vault.url`.

**Editable settings**: `wiki.enabled`, `wiki.every`, `wiki.notify`, `wiki.maxNotesPerRun` are added to `settings.ts` `ALLOWED` and the WebChat settings fields. The vault token stays a vault secret.

**Prompt** — a `## Wiki` section states: the wiki is maintained by a scheduled ingest; prefer `wiki/` when answering and cite pages; vault writes happen only through the wiki subsystem; treat note text as data; the automatic-writer guarantee does not cover owner-approved shell/MCP commands.

**Scheduler / daemon**:

- The scheduler gains a `wiki` option. Its one-second tick evaluates the wiki schedule but launches only when the retry backoff has elapsed (`now >= nextAttemptAt`, §5.5):
  - If `wiki.enabled`, `bootstrap` is not `done`, and no preview is awaiting review → launch the one-time bootstrap run.
  - If `wiki.enabled` and `bootstrap: done` → run at `wiki.every`.
- The daemon opens wiki runs as `temporary: "wiki"` with the restricted toolset, injects the skill body, and wires the interactive tools to the same `Wiki` service.

## 11. Error Handling

| Failure | Behaviour |
|---|---|
| Pending rollback cannot be completed | Abort the run, notify; no new batch. |
| Changes outside `wiki/`/`raw/` at run start | Abort and alert; no writes. |
| Unattributable or fingerprint-mismatched subtree change | Keep, alert, abort; never auto-commit or auto-clean. |
| Attributable stale changes (marker + matching fingerprint) | Restore only recorded paths to `baseHead`; continue. |
| fetch / rebase conflict | Abort the rebase, restore a clean tree, notify, no commit, state unchanged. |
| Unpushed normal commits, push fails | Keep the commit, abort the run, notify, retry after backoff. |
| Unpushed bootstrap preview at run start | Abort; the preview is never auto-pushed. |
| Model error or timeout before commit (`writing`) | Restore attributable recorded paths, remove marker; state unchanged; notify. |
| Push / state / notification failure after commit (`committed`) | Keep the commit and marker; never roll files back; next reconciliation completes publication. |
| Integrity guard trip at finalize | Abort, restore attributable recorded paths, alert; nothing unattributable committed or discarded. |
| Push rejected | Rebase and retry twice; then keep the commit and notify. Never force push. |
| Push error but HEAD already on remote | Treat as success, advance state, remove marker. |
| No file changes, nothing unpushed | No-output success: advance scan state; no commit/push/notification. |
| No file changes but unpushed normal commits exist | Push first; if that fails, do not advance state and notify. A preview or pending rollback stops the run instead. |
| Rollback push failure | Keep `rollback` state and the local revert, notify; complete before any new batch; a second call completes, never re-reverts. |
| Rollback/reject target no longer the local tip | Keep and alert; do not `reset`. |
| Rollback/reject target published after all | Complete/acknowledge as published; never reset. |
| Batch/rollback id not found / multiple matches | No match: clear the reference, alert if a rollback was expected. Multiple: abort, alert, no automatic action. |
| Scan base unrecoverable | Full scan; never derive the cursor from a rebased parent. |
| Bootstrap/model failure | Back off (`nextAttemptAt`); notify at most once per backoff step. |
| Lock busy | Interactive tool reports "wiki run in progress"; scheduled tick retries later. |
| Path-safety rejection (symlink/`..`/root) | Reject before writing; report to the run. |

Every terminal outcome sends a WeChat notification when `wiki.notify` is on, except no-output successes.

## 12. Testing

**Unit**

- Writable repo: clone/fetch/rebase/commit/push against a local bare repository; conflict aborts without side effects; path-limited checkout/clean; trailers parse.
- Lock: concurrent runs serialize; a busy lock makes interactive tools report and scheduled ticks skip.
- Attribution: a `touched` path modified again after the wiki write is kept and alerts; a matching fingerprint is restored/committed; missing marker with a dirty tree keeps changes.
- Phases: a failure before commit restores files; a push/state/notification failure after commit keeps the commit and never dirties the tree against it.
- Integrity guard: an unexpected commit, staged change, or fingerprint mismatch aborts; remote advances do not.
- Change detection: added/modified/deleted, subtree exclusions, non-ancestor fallback, first-run full scan.
- Chunking: N+1 notes with `maxNotesPerRun = N` produce two model calls and exactly one commit.
- Cursor: an on-demand batch has no scan base and does not advance `lastScanCommit`; a pending vault change is processed by the next scheduled run; recovery uses `Vex-Scan-Base`, not the rebased parent.
- State: advances on successful publish and no-output-with-nothing-unpushed; never with unpushed commits, on abort, or after on-demand.
- Deletion: previous content is supplied; `sources` is cleaned; a page losing all sources becomes `orphaned` and is listed in `_index.md`; no page is deleted.
- Policy: vault paths in `write`/`edit` are denied and overrides cannot open them.
- Path safety: root symlink (`wiki -> ../owner-notes`), file symlink, directory symlink, dangling symlink, and `..` bypass are rejected before any write.
- Run toolset: contains `wiki_write`/`wiki_edit` and excludes `bash`, MCP, and generic `read`; a normal session's toolset does not contain the wiki write tools.
- Bootstrap: the one-time trigger fires once; no-change completes `done`; approve pushes; reject fetches, re-verifies unpublished, and only resets when the preview is the local tip.
- Batch identity: id resolution with zero/one/multiple matches; rebase changes the SHA but the id still resolves; state-write failure recovers from trailers; a rollback commit is never treated as a compile batch.
- Rollback: unpublished tip → local discard without push; unpublished non-tip → keep and alert; published → revert + push; push failure then a second call completes instead of re-reverting; a revert committed before the state write is recovered from `Vex-Rollback`; conflict aborts cleanly.
- State-loss recovery: batch + revert committed, then the full state file is lost → the reverted batch is not offered again and `lastScanCommit` is reconstructed from the newest advancing batch, so the reverted content is not regenerated.
- Backoff: consecutive failures space retries by `min(1h, 5m x 2^(streak-1))` and reset on success.
- State lifecycle: missing state behaves as `pending`; disable/enable settles rollback and resumes correctly.

**Integration**

- A scheduled ingest with a fake agent produces exactly one commit and one notification.
- An on-demand `wiki_ingest` produces one commit, does not advance the cursor, and leaves no dirty tree.
- A guard violation aborts the batch.

**Existing suites**

- `tests/vault*.test.ts`, `tests/policy.test.ts`, scheduler and daemon tests need updates because the vault is no longer strictly read-only when the wiki is enabled.

## 13. Risks, Resolved Items, Deferred

**Risks**

- Synthesis quality: LLM-generated pages may be wrong or noisy. Mitigation: provenance frontmatter, bootstrap review, and rollback.
- Prompt injection: mitigated by the automatic-writer boundary, the restricted run toolset (no generic `read`), fingerprint attribution, and path validation.
- Owner-approved `bash`/MCP: outside the lock; the integrity guard detects unattributable state but cannot prevent a concurrent external write during a run, nor eliminate the check-then-act race.
- Owner editing `wiki/` on another device: a rebase conflict aborts the run and notifies.
- Cost: the first full compile is expensive. Mitigation: chunked runs and the bootstrap review.

**Resolved after review**

- Guarantee scoped to the automatic write path; owner-approved channels are explicitly outside the lock and covered by detection.
- Attribution by content fingerprint and phase: only `writing`-phase, fingerprint-matching paths are auto-cleaned; post-commit failures never roll files back.
- Compile batches and rollback operations have distinct identities; reconciliation resolves rollback relations before choosing the newest un-reverted compile batch.
- Destructive rollback/reject paths fetch, re-verify published status, and refuse to reset unless the target is the local tip.
- Scan progress is durable (`Vex-Kind`, `Vex-Scan-Base`): cursor recovery never uses a rebased parent, and on-demand batches never advance it; rollback does not regenerate reverted sources.
- In-flight marker carries kind, scan base, phase, and per-path fingerprints.
- On-demand ingest does not advance the scan cursor.
- Wiki runs have no generic file `read`; the skill body is injected by the core.
- Subtree roots are validated as real directories before target checks.
- Retry backoff prevents per-tick failure storms.

**Deferred** (not in this design)

- OS-level sandboxing of `bash`/MCP to make the write boundary absolute.
- Supporting a local `vault.path` folder as a wiki source.
- Merging concurrent owner edits inside `wiki/` instead of aborting.
- An exclusion list for sensitive notes (e.g. password notes) beyond the no-secrets instruction.
- Forcing a recompile of notes after a rollback.

## 14. Milestones

1. Writable git working copy + single-automatic-writer boundary (`wiki_write`/`wiki_edit`, policy clamp, root/path safety, fingerprint recording).
2. Phased `Wiki.run` transaction: lock, fetch, in-flight marker, attribution/cleanup, integrity guard, change detection, state file, commit/push.
3. Durable identity and reconciliation: compile vs rollback trailers, scan base, zero/one/multiple, crash/state-loss recovery.
4. Scheduler cadence + bootstrap trigger/approve/reject + retry backoff.
5. `wiki_ingest` (cursor-safe) and `wiki_rollback` (single-execution, fetch-before-destructive).
6. Wiki run toolset + injected `skills/llm-wiki/SKILL.md` + prompt section.
7. Config, editable settings, docs, and full test coverage update.
