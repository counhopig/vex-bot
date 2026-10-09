# LLM Wiki for the Notes Vault — Design

**Date:** 2026-10-09
**Status:** Rev 3 — write path and transaction model finalized; awaiting re-review
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
9. **Single writer, locked transaction** (finalized after review, supersedes the earlier "reuse `write`/`edit` with a policy allow-list"): only the wiki subsystem writes the vault, through dedicated tools available only inside a locked wiki run. General `write`/`edit` never write the vault. This is what makes the lock cover every actual write without threading session identity into the policy layer.

## 3. Goals and Non-Goals

**Goals**

- Periodically compile new/changed vault notes into durable topic pages under `<vault>/wiki/`.
- Answer questions from the wiki first, with citations back to pages and source notes.
- Keep the vault's non-wiki content strictly read-only, and keep all vault writes inside a locked transaction.
- Make every automated batch one commit, notified and revertible.
- Survive concurrent edits on other devices without data loss or force pushes.

**Non-goals**

- No web UI for the wiki; Obsidian is the reader.
- No changes to the existing memory index (`memory_search`) or compaction.
- No editing of the owner's pre-existing notes.
- No embeddings/vector store; retrieval stays keyword + link based like the existing vault tools.

## 4. Architecture

### 4.1 Components

| Component | Change | Responsibility |
|---|---|---|
| `src/vault/git.ts` | Extend | Add a writable working copy (clone, fetch, rebase, commit, push, reset, revert). Keep the read-only mirror for vault-only setups. |
| `src/vault/notes.ts` | Small change | Read from the shared writable working copy when the wiki is enabled. |
| `src/wiki/` (new) | New | Working copy, lock, batch transaction, change detection, state file, subtree guards, run orchestration, notifications, bootstrap, rollback. |
| `src/tools/` (new) | New | Interactive `wiki_ingest`, `wiki_bootstrap`, `wiki_rollback`; run-internal `wiki_write`, `wiki_edit`. |
| `src/policy/policy.ts` | Small change | Vault paths in `write`/`edit` are clamped to deny; no allow-list opens them. |
| `skills/llm-wiki/SKILL.md` (new) | New | Editorial procedure: synthesize topic pages, deduplicate, link, maintain the index, handle deletions, never copy secrets. |
| `src/scheduler/index.ts` | Extend | Bootstrap trigger and `wiki.every` cadence. |
| `src/daemon.ts` | Extend | Open wiki runs (`temporary: "wiki"`) with a restricted toolset; wire `wiki_ingest`/`wiki_bootstrap`/`wiki_rollback`. |
| `src/context/prompt.ts` | Extend | A `## Wiki` section describing tools, layout, and boundaries. |
| `src/config/schema.ts`, `load.ts`, `settings.ts` | Extend | `wiki` configuration and editable settings. |

Layering stays as it is: `src/wiki/` depends on `src/vault/git.ts`; the daemon wires both and injects the shared working copy into `Vault`.

### 4.2 Write path and locked transaction

**Single writer.** The vault's `wiki/` and `raw/` subtrees are written only through `wiki_write`/`wiki_edit`, which are registered **only** inside a wiki run and are bound to those two subtrees. General `write`/`edit` never write the vault (their vault paths are denied, §9). The existing `write`/`edit` behavior inside the workspace is unchanged.

**One lock per working copy.** The `Wiki` service owns an in-process async mutex. Every wiki run goes through `Wiki.run(kind, task, signal)`:

1. Acquire the lock. If it is busy, an interactive tool returns "wiki run in progress"; the scheduled tick is skipped and retried later.
2. `git fetch`, then `git rebase origin/<branch>`. On conflict: abort, restore a clean tree, notify, release. Nothing was written.
3. **Precondition.** Changes outside `wiki/` and `raw/` mean something wrote past Vex's boundary: abort and alert. Changes inside `wiki/`/`raw/` are a stale batch (a crashed run): discard them with the abort cleanup below and continue.
4. **Unpushed commits.** Inspect `git log origin/<branch>..HEAD`. If any unpushed commit is a bootstrap preview (§4.7, §4.8), it is awaiting review: abort the run without processing anything, because a preview must never be pushed by the generic path. Otherwise, if `HEAD` is ahead of `origin/<branch>` (a previous push failed), try to push now; if that fails, abort the run without processing anything and notify; state is unchanged.
5. Record `baseHead = HEAD`.
6. Launch a temporary agent run (`temporary: "wiki"`) with the restricted toolset (`read`, `vault_search`, `vault_read`, `wiki_write`, `wiki_edit`). No `bash`, no MCP, no network tools.
7. Finalize: stage `git add -- wiki/ raw/`, run the boundary check (§8), commit once (unless the bootstrap withholds the push, §4.7), push, advance state, notify.
8. On any failure: `abortBatch` discards only the batch — `git checkout -- wiki/ raw/` plus `git clean -fd -- wiki/ raw/` — leaves state unchanged, notifies, and releases.

**Attribution.** The lock is held for the whole run and only the run's tools can write the vault, so every `wiki/`/`raw/` change between steps 5 and 7 belongs to this batch. No other session can write those paths, and no session identity is needed.

**Lock scope.** In-process only; one daemon owns one working copy.

### 4.3 Data flow — scheduled ingest

1. The scheduler runs at the `wiki.every` cadence only when `wiki.enabled` and `bootstrap: done`.
2. It calls the daemon's wiki hook, which enters `Wiki.run("scheduled", ...)` (§4.2).
3. Change detection computes added/modified/deleted notes since `lastScanCommit` (§6), including previous content for deletions.
4. If nothing changed, the run ends as a **no-output success**: advance `lastScanCommit` to `baseHead` (only if `HEAD == origin/<branch>`, §8), leave `lastBatchCommit` unchanged, release; no commit, no push, no model call, no notification.
5. Otherwise the changed notes are split into chunks; each chunk is one model call following `skills/llm-wiki/SKILL.md`.
6. After the last chunk the run finalizes as in §4.2 step 7.

### 4.4 Data flow — on-demand ingest

1. The owner sends a link, text, or file in WeChat/WebChat.
2. The **main session** fetches or extracts the content (`web_fetch`, or the link-reader skill for platforms like Bilibili/YouTube). The owner is present, so the normal toolset and approvals apply.
3. The main session calls `wiki_ingest({ url?, title?, text })`. `text` carries the extracted content; `url` and `title` are provenance metadata.
4. `wiki_ingest` starts `Wiki.run("on-demand", ...)` with the provided source. The run writes `raw/`, compiles `wiki/`, commits, pushes, and notifies, then returns a summary (pages changed, commit) to the main session.
5. While `bootstrap: pending`, `wiki_ingest` refuses and tells the owner to approve or reject the first compile.
6. If the session ends before the run finishes, the run's transaction either commits or aborts; there is no partially-written working tree left behind.

### 4.5 Data flow — query

1. The owner asks a question.
2. The agent searches the wiki first (`vault_search` with `folder: "wiki"`), reads matching pages, and answers with citations to wiki pages and, where useful, source notes.
3. If the wiki has nothing, the agent falls back to a full-vault search.

### 4.6 Data flow — rollback

`wiki_rollback` reverts the most recent committed batch, distinguishing published from unpublished commits. It is refused while `bootstrap: pending`; use `wiki_bootstrap` then.

1. Acquire the lock; if busy, report "wiki run in progress". Require a clean tree.
2. If `lastBatchCommit` is `null` (no batch has committed), report that there is nothing to roll back.
3. Fetch. Determine whether `lastBatchCommit` is on `origin/<branch>`.
   - **Not on the remote** (an unpublished commit, e.g. a bootstrap preview): discard it locally with `git reset --hard <parent>` — **no push**.
   - **On the remote**: `git revert --no-edit <lastBatchCommit>` and push. On a revert conflict, `git revert --abort`, keep state, and notify for manual resolution. Never force push.
4. On success set `lastBatchCommit = null` and report the resulting commit.
5. Rollback does not move `lastScanCommit`: the rejected compilation is not regenerated until its source notes change again, so the owner's rollback sticks.

### 4.7 Bootstrap

The first full compile is reviewed before Vex may push anything.

- **Trigger.** When `wiki.enabled` is true, `bootstrap` is not `done`, no preview is awaiting review (none unpushed; §4.8), and the retry backoff has elapsed (`now >= nextAttemptAt`, §5.5), the scheduler launches a one-time bootstrap run (separate from the recurring cadence). The launch is evaluated on the scheduler's one-second tick but gated by the backoff, so a failure does not produce a per-second retry storm. A preview awaiting review stops the trigger until the owner acts.
- **Run.** The bootstrap run compiles the whole vault in chunks, commits locally, and withholds the push. It records `lastBatchCommit` and notifies the owner with the changed-page summary and commit. `bootstrap` stays `pending`.
- **Empty vault / no changes.** The run ends as a no-output success and immediately sets `bootstrap: done`; there is nothing to review.
- **Approve** (`wiki_bootstrap({ action: "approve" })`): acquire the lock, fetch, and follow §8's rebase/retry rules to push the pending commit (already-on-remote is fine). On a rebase conflict, abort the rebase, keep the preview commit and `bootstrap: pending`, and notify; never force push. On success, set `bootstrap: done` and arm the cadence. With no pending commit, report that there is nothing to approve.
- **Reject** (`wiki_bootstrap({ action: "reject" })`): acquire the lock and discard the unpublished commit locally (`git reset --hard <parent>`) — **no push** — keeping `bootstrap: pending` so it can be rebuilt. With no pending commit, report that there is nothing to reject.
- While `pending`, `wiki_ingest` and `wiki_rollback` refuse; only `wiki_bootstrap` acts. This keeps the unpublished preview from ever reaching the remote.

### 4.8 Preview recognition and state recovery

The bootstrap commit message begins with `wiki: bootstrap preview`. This marker is durable and lets Vex recognise a preview even if the state file is lost or stale.

On startup and before every run, `Wiki` reconciles the marker with the state file:

- An **unpushed** commit whose subject starts with the marker (`git log origin/<branch>..HEAD`) means the preview is awaiting review: set `bootstrap: pending` and `lastBatchCommit` to that commit, and never push it except through `wiki_bootstrap({action:"approve"})`.
- A marker commit **on `origin/<branch>`** means the preview was approved and pushed: set `bootstrap: done`.
- No marker anywhere with a missing or partial state file: `bootstrap: pending` and a full scan (conservative).

Preview protection takes precedence over the generic unpushed-commit push (§4.2 step 4), over the no-output advance (§8), and over any other automatic push.

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
  "lastBatchCommit": "<sha | null>",
  "bootstrap": "pending | done",
  "nextAttemptAt": 1791542400000,
  "failureStreak": 0
}
```

- `lastScanCommit` advances on a successful push, an already-on-remote HEAD, or a no-output batch with nothing unpushed; never on abort.
- `lastBatchCommit` is the most recent batch that produced a commit — what `wiki_rollback` reverts — or `null` if no batch has committed yet. No-output batches leave it unchanged.
- `bootstrap` gates the cadence (§4.7) and is reconciled from the preview marker on state loss (§4.8).
- `nextAttemptAt` and `failureStreak` implement the retry backoff: a failed run increments the streak and sets `nextAttemptAt = now + min(1h, 5m x 2^(streak-1))`; a success resets both. The scheduler launches a run only when `now >= nextAttemptAt`.

### 5.6 State lifecycle

- **Missing or partial state while `wiki.enabled`** is treated as `bootstrap: pending` and a full scan, then reconciled with the preview marker (§4.8): a lost state file must not let Vex push without review.
- **Disabled** (`wiki.enabled` false): the cadence stops. A pending bootstrap commit is kept. Re-enabling resumes the bootstrap review when `pending`, or the cadence when `done`.
- **`lastScanCommit` missing or no longer an ancestor of `HEAD`**: full scan.

### 5.7 Page naming

Topic slugs are stable once created; renaming breaks `[[wikilinks]]`. Aliases go in Obsidian `aliases` frontmatter instead of renaming.

## 6. Change Detection and Chunking

- After syncing, run `git diff --name-status <lastScanCommit>..HEAD -- '*.md'` and parse added/modified/deleted paths.
- Exclude `wiki/` and `raw/` (Vex-owned), hidden directories, and non-Markdown files.
- If `lastScanCommit` is missing or is no longer an ancestor of `HEAD` (force push, rewritten history, first run), fall back to a full scan.
- The diff is split into chunks of at most `wiki.maxNotesPerRun` notes. `maxNotesPerRun` bounds **one model call**; a run processes every chunk and still makes exactly one commit.
- Each deleted path is accompanied by its previous content from `git show <lastScanCommit>:<path>`.
- Advance `lastScanCommit` to `baseHead` only per §5.5.

## 7. Ingest Execution

- A run's prompt lists the changed notes (or the on-demand source) and the editorial procedure from `skills/llm-wiki/SKILL.md`.
- The run toolset is `read`, `vault_search`, `vault_read`, `wiki_write`, `wiki_edit`; no `bash`, MCP, or network tools.
- The editorial procedure: read changed notes (and deleted-note previous content), identify topics, update or create topic pages, update `_index.md`, add `[[wikilinks]]`, record `sources`, apply the deletion rule, and never copy secret values.
- `wiki_write` overwrites a page; `wiki_edit` makes a targeted replacement. Both reject lexical paths outside `wiki/`/`raw/` and, at write time, any target whose real path escapes those subtrees through a symlink (§9).
- A failed run leaves state unchanged; the whole diff is retried next attempt. Re-processing compiled notes is idempotent.

## 8. Git Workflow

- The wiki uses a normal clone (not the read-only mirror) checked out on the configured branch, stored under the data directory.
- Fetch + rebase before a run; a conflict aborts the run.
- Precondition, unpushed-commit handling, and abort cleanup are in §4.2.
- Stage `git add -- wiki/ raw/` only.
- Boundary check: `git status --porcelain` must list nothing outside `wiki/` and `raw/`. If it does, treat it as a guard violation: discard the offending paths, abort the batch, and alert.
- Commit only if there are staged changes; one commit per batch, message `wiki: ingest <date> (<N> notes, <M> pages)`.
- Push. On rejection (non-fast-forward), fetch + rebase + retry up to 2 times. If it still fails, keep the local commit and notify.
- **Already-pushed recovery**: after a push error, `git fetch` and check `git merge-base --is-ancestor HEAD origin/<branch>`; if HEAD is already on the remote, treat the push as successful and advance state.
- **No-output batches** may advance `lastScanCommit` only when `HEAD == origin/<branch>`. If unpushed normal commits remain, push them first; if that fails, do not advance state and notify. An unpushed bootstrap preview is never pushed here (§4.2 step 4, §4.8) and stops the run. This guarantees local wiki content is eventually published or the owner is told.
- Never force push.
- Credentials come from `vault.username`/`vault.token` through the environment, as today, but the token needs write scope.

## 9. Boundaries and Security

1. **Single writer**: only `wiki_write`/`wiki_edit`, registered only in a locked wiki run, can write the vault; general `write`/`edit` cannot write vault paths at all.
2. **Policy clamp**: for `write`/`edit`, any vault path is clamped to `deny` and cannot be opened by `tools.policy` overrides. The protected-path check runs before tool overrides.
3. **Tool binding and path safety**: `wiki_write`/`wiki_edit` are bound to `<vault>/wiki` and `<vault>/raw`. At write time they resolve the target's real path and the real subtree roots (following existing symlinks; for a new path, the nearest existing ancestor, reusing the `resolveRealPath` pattern in `policy.ts`) and reject any target that escapes the subtrees, passes through a directory symlink that escapes, or is a dangling symlink. Because abort cleanup cannot restore a file changed outside the subtrees, this check is the primary protection and the finalize boundary check is only a backstop.
4. **Lock + preconditions**: no other writer can act during a run, and a run refuses to start on a tree with changes outside its subtrees.
5. **Staging + post-write check**: `git add -- wiki/ raw/` only; `git status --porcelain` must show nothing outside the subtrees.
6. **Unpublished preview**: a bootstrap commit cannot be pushed except through `wiki_bootstrap({action:"approve"})`.

Other rules:

- Note text is untrusted input. The single-writer boundary and the restricted run toolset are the primary mitigations.
- Wiki pages must not reproduce credentials, tokens, passwords, or secret values; they may describe that a note exists and what it covers.
- `wiki_write`/`wiki_edit` exist only inside wiki runs; a normal session cannot obtain them.
- The existing `vault_read`/`vault_search` tools remain, now reading the shared working copy.

## 10. Tools, Prompt, Scheduler, Configuration

**Interactive tools** (registered in normal sessions when the wiki is enabled)

| Tool | Parameters | Behaviour |
|---|---|---|
| `wiki_ingest` | `{ url?, title?, text }` | Start a locked on-demand wiki run with the extracted source; write `raw/`, compile `wiki/`, commit, push, notify; return a summary. Refused while the bootstrap is pending. |
| `wiki_bootstrap` | `{ action: "approve" \| "reject" }` | Approve: push the pending bootstrap commit, set `bootstrap: done`, arm the cadence. Reject: discard the unpublished commit locally, keep `pending`. |
| `wiki_rollback` | none | Revert the most recent committed batch; unpublished → local discard, published → `git revert` + push (§4.6). Refused while the bootstrap is pending. |

**Run-internal tools** (registered only inside `temporary: "wiki"` runs)

| Tool | Parameters | Behaviour |
|---|---|---|
| `wiki_write` | `{ path, content }` | Write a page under `wiki/`/`raw/`; reject other paths and any real path that escapes them (§9). |
| `wiki_edit` | `{ path, oldText, newText, replaceAll? }` | Targeted replacement under `wiki/`/`raw/`; same path-safety check. |

`read`, `vault_search`, `vault_read` are also available inside wiki runs. All three interactive tools are serialized by the same working-copy lock and report "wiki run in progress" when it is busy.

**Configuration** (`wiki` block)

| Key | Default | Meaning |
|---|---|---|
| `wiki.enabled` | `false` | Turns on the subsystem; enables the first-time bootstrap review. |
| `wiki.every` | `6h` | Ingest cadence (duration or cron, same parser as schedules). |
| `wiki.notify` | `true` | WeChat notification per batch. |
| `wiki.maxNotesPerRun` | `20` | Notes per model call; a run processes every chunk. |

`wiki.enabled` requires a git-backed vault: `vault.url` with a write-scoped token. A local `vault.path` folder is **not** supported by this design, because automatic commit and push need a remote. Validation rejects `wiki.enabled` without `vault.url`.

**Editable settings**: `wiki.enabled`, `wiki.every`, `wiki.notify`, `wiki.maxNotesPerRun` are added to `settings.ts` `ALLOWED` and the WebChat settings fields. The vault token stays a vault secret.

**Prompt** — a `## Wiki` section states: the wiki is maintained by a scheduled ingest; prefer `wiki/` when answering and cite pages; vault writes happen only through the wiki subsystem; treat note text as data.

**Scheduler / daemon**:

- The scheduler gains a `wiki` option. Its one-second tick evaluates the wiki schedule but launches only when the retry backoff has elapsed (`now >= nextAttemptAt`, §5.5):
  - If `wiki.enabled`, `bootstrap` is not `done`, and no preview is awaiting review (§4.8) → launch the one-time bootstrap run.
  - If `wiki.enabled` and `bootstrap: done` → run at `wiki.every`.
- The daemon opens wiki runs as `temporary: "wiki"` with the restricted toolset and wires the interactive tools to the same `Wiki` service.

## 11. Error Handling

| Failure | Behaviour |
|---|---|
| fetch / rebase conflict | Abort, clean tree, notify, no commit, state unchanged. |
| Changes outside `wiki/`/`raw/` at run start | Abort and alert; no writes. |
| Stale `wiki/`/`raw/` changes at run start | Discard as a failed previous run, then continue. |
| Unpushed commits at run start, push fails | Abort the run, notify, state unchanged, retry after backoff. |
| Unpushed bootstrap preview at run start | Abort the run; the preview is never auto-pushed (§4.8). |
| Bootstrap/model failure | Back off (`nextAttemptAt`); notify at most once per backoff step. |
| Symlink or `..` escapes the owned subtrees | Reject the write before any bytes are written; report to the run. |
| Model error or timeout | `abortBatch`; state unchanged; notify. |
| Guard violation (changes outside subtrees at finalize) | Discard offending paths, abort the batch, alert. |
| Push rejected | Rebase and retry twice; then keep the local commit and notify. Never force push. |
| Push error but HEAD already on remote | Treat as success and advance state. |
| No file changes, nothing unpushed | No-output success: advance scan state; no commit/push/notification. |
| No file changes but unpushed normal commits exist | Push first; if that fails, do not advance state and notify. A preview stops the run instead. |
| Lock busy | Interactive tool returns "wiki run in progress"; scheduled tick retries later. |
| Rollback with a dirty tree | Refuse and notify. |
| Rollback conflict | `git revert --abort`, keep state, notify for manual resolution. |
| Bootstrap reject/approve | Reject discards locally without pushing; approve pushes the preview. |

Every terminal outcome sends a WeChat notification when `wiki.notify` is on, except no-output successes.

## 12. Testing

**Unit**

- Writable repo: clone/fetch/rebase/commit/push against a local bare repository; conflict aborts without side effects; reset/revert helpers.
- Lock: concurrent runs serialize; a busy lock makes interactive tools report and scheduled ticks skip.
- Preconditions: run refuses when changes exist outside the subtrees; stale `wiki/`/`raw/` changes are discarded; unpushed normal commits are pushed or the run aborts; an unpushed bootstrap preview always stops the run and is never pushed.
- Preview recognition: state loss after a preview commit is reconciled from the commit marker; a pushed marker means `done`.
- Backoff: consecutive failures space retries by `min(1h, 5m x 2^(streak-1))` and reset on success.
- Path safety: file symlink, directory symlink, dangling symlink, and `..` bypass are rejected before any write; an escaping symlink is never followed.
- Change detection: added/modified/deleted, subtree exclusions, non-ancestor fallback, first-run full scan.
- Chunking: N+1 notes with `maxNotesPerRun = N` produce two model calls and exactly one commit.
- State: advances on successful push, already-on-remote HEAD, and a no-output batch with nothing unpushed; never with unpushed commits or on abort.
- Deletion: previous content is supplied; `sources` is cleaned; a page losing all sources becomes `orphaned` and is listed in `_index.md`; no page is deleted.
- Policy: vault paths in `write`/`edit` are denied and overrides cannot open them.
- `wiki_write`/`wiki_edit`: bound to the subtrees; other paths rejected.
- `wiki_ingest`: the main session supplies text; the run commits once; refused while the bootstrap is pending.
- Bootstrap: the one-time trigger fires once; no-change completes `done`; approve pushes; reject discards locally and never pushes.
- `wiki_rollback`: unpublished commit → local discard without push; published commit → revert + push; second call reports nothing to roll back; conflict aborts cleanly.
- State lifecycle: missing state behaves as `pending`; disable/enable resumes correctly.

**Integration**

- A scheduled ingest with a fake agent produces exactly one commit and one notification.
- An on-demand `wiki_ingest` produces one commit and does not leave a dirty tree.
- A guard violation aborts the batch.
- Run toolset contains `wiki_write`/`wiki_edit` and excludes `bash`/MCP; a normal session's toolset does not contain the wiki write tools.

**Existing suites**

- `tests/vault*.test.ts`, `tests/policy.test.ts`, scheduler and daemon tests need updates because the vault is no longer strictly read-only when the wiki is enabled.

## 13. Risks, Resolved Items, Deferred

**Risks**

- Synthesis quality: LLM-generated pages may be wrong or noisy. Mitigation: provenance frontmatter, bootstrap review, and rollback.
- Prompt injection: mitigated by the single-writer boundary, the restricted run toolset, and the no-secrets rule.
- Owner editing `wiki/` on another device: a rebase conflict aborts the run and notifies; the owner's edit wins because Vex abandons the run.
- Cost: the first full compile is expensive. Mitigation: chunked runs and the bootstrap review.

**Resolved after review**

- Single writer + locked run replaces the `write`/`edit` policy allow-list; the lock now covers every actual vault write without session identity.
- On-demand ingest is `wiki_ingest` + a locked temporary run; the main session fetches/extracts content.
- Bootstrap has a defined trigger, an approve/reject tool, and a no-push reject path; unpublished commits cannot reach the remote.
- `wiki_rollback` is remote-aware.
- Unpushed-commit and no-output interactions are defined; state advances only when content is published (or no content exists).
- State loss and re-enable behaviour are defined; previews are recognised from a commit marker and protected from automatic push.
- Failed runs back off instead of retrying every scheduler tick.
- `wiki_write`/`wiki_edit` reject symlink and `..` escapes at write time, before any bytes are written.
- Bootstrap approve uses the normal rebase/retry rules and preserves the preview on conflict.
- Deleted sources keep previous content, clean `sources`, and mark pages `orphaned`.
- `maxNotesPerRun` bounds one model call; a run makes one commit.
- `wiki.*` settings are editable in the WebChat settings screen; default cadence `6h`.

**Deferred** (not in this design)

- Forcing a recompile of notes after a rollback.
- Supporting a local `vault.path` folder as a wiki source.
- Merging concurrent owner edits inside `wiki/` instead of aborting.

## 14. Milestones

1. Writable git working copy + single-writer boundary (`wiki_write`/`wiki_edit`, policy clamp).
2. `Wiki.run` transaction, lock, change detection, state file, commit/push, unpushed-commit handling.
3. Wiki run toolset in the daemon + `skills/llm-wiki/SKILL.md` + prompt section.
4. Scheduler cadence + bootstrap trigger + `wiki_bootstrap`.
5. `wiki_ingest` and `wiki_rollback`.
6. Config, editable settings, docs, and full test coverage update.
