# LLM Wiki for the Notes Vault — Design

**Date:** 2026-10-09
**Status:** Rev 2 — revisions after review; awaiting re-review
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

## 3. Goals and Non-Goals

**Goals**

- Periodically compile new/changed vault notes into durable topic pages under `<vault>/wiki/`.
- Answer questions from the wiki first, with citations back to pages and source notes.
- Keep the vault's non-wiki content strictly read-only for the automatic write path.
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
| `src/vault/git.ts` | Extend | Add a writable working copy (clone, fetch, rebase, commit, push). Keep the read-only mirror for vault-only setups. |
| `src/vault/notes.ts` | Small change | Read from the shared writable working copy when the wiki is enabled. |
| `src/wiki/` (new) | New | Working-copy lifecycle, batch transaction (`beginBatch`/`commitBatch`/`abortBatch`), lock, change detection, state file, subtree write guard, notifications, rollback. |
| `src/tools/` (new tools) | New | `wiki_commit` (finalize/push a batch) and `wiki_rollback`; `write`/`edit` are used for page writes. |
| `src/policy/policy.ts` | Extend | Protected-vault-path check that runs **before** tool overrides; `write`/`edit` may auto-write only inside `wiki/` and `raw/`. |
| `skills/llm-wiki/SKILL.md` (new) | New | Editorial procedure: synthesize topic pages, deduplicate, link, maintain the index, handle deletions, never copy secrets. |
| `src/scheduler/index.ts` | Extend | A `wiki` cadence and a `"wiki"` temporary-run kind. |
| `src/context/prompt.ts` | Extend | A `## Wiki` section describing tools, layout, and boundaries. |
| `src/config/schema.ts`, `load.ts`, `settings.ts` | Extend | `wiki` configuration and editable settings. |

Layering stays as it is: `src/wiki/` depends on `src/vault/git.ts`; the daemon wires both and injects the shared working copy into `Vault`.

### 4.2 Batch transaction and locking

All mutations of the working copy go through one process-wide async mutex per working copy (`Wiki` lock). Participating operations: the scheduled ingest run, interactive `wiki_commit`, and `wiki_rollback`.

- **Acquire** the lock, then `git fetch` and `git rebase origin/<branch>`. On conflict: abort, restore a clean tree, notify, release. Nothing was written.
- **Precondition**: after the rebase, the tree must hold no changes outside `wiki/` and `raw/`. Changes outside them mean something wrote past Vex's boundary: abort and alert. Changes inside `wiki/` or `raw/` are a stale batch (a crashed run, or an interactive ingest that ended without `wiki_commit`); discard them with the abort cleanup below and continue.
- **Begin**: record `baseHead = HEAD`.
- **Attribution**: with the lock held and the tree clean at begin, every change under `wiki/` and `raw/` until commit or abort belongs to this batch.
- **Abort**: discard only the batch — `git checkout -- wiki/ raw/` plus `git clean -fd -- wiki/ raw/` — and never touch other paths or advance state. (Nothing else can be dirty, by the precondition.)
- **Commit/push**: stage `git add -- wiki/ raw/`, run the boundary check (§8), commit, push, then advance state.
- The lock is held for the whole of a batch: one scheduled run (sync → model calls → commit/push), or one interactive ingest from `beginBatch` to `wiki_commit`/abort. A scheduled run that finds the lock busy skips this tick and retries next tick; an interactive operation that finds it busy returns "wiki ingest in progress".
- The lock is in-process only; it does not coordinate across processes. One Vex daemon owns one working copy.

### 4.3 Data flow — scheduled ingest

1. The scheduler fires the `wiki` cadence (only when `wiki.enabled` and the bootstrap is done, §7) and launches a `"wiki"` temporary run.
2. The run acquires the lock and begins a batch (§4.2).
3. Change detection computes added/modified/deleted notes since `lastScanCommit` (§6), including previous content for deletions.
4. If nothing changed, the batch ends as a **no-output success**: advance `lastScanCommit` to `baseHead`, leave `lastBatchCommit` unchanged, release; no commit, no push, no model call, no notification.
5. Otherwise the changed notes are split into chunks (§6). Each chunk is one model call with the editorial procedure from `skills/llm-wiki/SKILL.md`.
6. The run's toolset is restricted: `read`, `write`, `edit`, `vault_search`, `vault_read`. No `bash`, no MCP, no network tools.
7. After the last chunk, `commitBatch` stages, boundary-checks, commits once, pushes, advances state, and notifies.
8. Any failure ends in `abortBatch`; state is unchanged and the owner is notified.

### 4.4 Data flow — on-demand ingest

1. The owner sends a link or text in WeChat/WebChat.
2. The agent fetches the content (`web_fetch` or the link-reader skill) and begins a batch (`beginBatch`).
3. It writes the source into `raw/` with provenance frontmatter, then compiles `wiki/` pages.
4. It calls `wiki_commit` to stage, boundary-check, commit, push, advance state, and notify.
5. On failure the agent calls `wiki_commit` with nothing staged, which aborts the batch and reports that there is nothing to commit; if the session ends without a commit, the next `beginBatch` discards the stale `wiki/`/`raw/` changes at the precondition.

The interactive toolset is the normal one (the owner is present). The batch boundary is explicit: `wiki_commit` is the only way a normal session commits wiki changes.

### 4.5 Data flow — query

1. The owner asks a question.
2. The agent searches the wiki first (`vault_search` with `folder: "wiki"`), reads matching pages, and answers with citations to wiki pages and, where useful, source notes.
3. If the wiki has nothing, the agent falls back to a full-vault search.

### 4.6 Data flow — rollback

1. The owner replies "roll back the last batch" (or equivalent).
2. `wiki_rollback` acquires the lock and requires a clean tree.
3. If `lastBatchCommit` is `null` (no batch has ever committed), it reports that there is nothing to roll back and releases.
4. It `git fetch`es. If the commit is not in `origin/<branch>` and not in local history anymore, it clears `lastBatchCommit` and reports that there is nothing to revert.
5. It runs `git revert --no-edit <lastBatchCommit>` and pushes. On a revert conflict it runs `git revert --abort`, keeps state, and notifies the owner to resolve manually. Never force push.
6. On success it sets `lastBatchCommit = null` and reports the new commit.
7. Rollback does **not** move `lastScanCommit`: the rejected compilation is not regenerated until its source notes change again, so the owner's rollback sticks.

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
  "bootstrap": "pending | done"
}
```

- `lastScanCommit` advances on a successful push, an already-on-remote HEAD, or a no-output batch; never on abort.
- `lastBatchCommit` is the most recent batch that produced a commit — what `wiki_rollback` reverts — or `null` if no batch has committed yet. No-output batches leave it unchanged.
- `bootstrap` gates the cadence (§7).

### 5.6 Page naming

Topic slugs are stable once created; renaming breaks `[[wikilinks]]`. Aliases go in Obsidian `aliases` frontmatter instead of renaming.

## 6. Change Detection and Chunking

- After syncing, run `git diff --name-status <lastScanCommit>..HEAD -- '*.md'` and parse added/modified/deleted paths.
- Exclude `wiki/` and `raw/` (Vex-owned), hidden directories, and non-Markdown files.
- If `lastScanCommit` is missing or is no longer an ancestor of `HEAD` (force push, rewritten history, first run), fall back to a full scan.
- The diff is split into chunks of at most `wiki.maxNotesPerRun` notes. `maxNotesPerRun` bounds **one model call**; a run processes every chunk and still makes exactly one commit.
- Each deleted path is accompanied by its previous content from `git show <lastScanCommit>:<path>`.
- Advance `lastScanCommit` to `baseHead` only when the whole diff has been processed and the outcome is a successful push, an already-on-remote HEAD, or a no-output batch.

## 7. Bootstrap and Ingest Execution

**Bootstrap gate**

- Setting `wiki.enabled` records `bootstrap: pending`. The cadence does not run until `bootstrap: done`.
- The first ingest (at the next tick, or when the owner says "build the wiki") compiles the whole vault in chunks, commits locally, and **withholds the push**. It records `lastBatchCommit` and notifies the owner with the changed-page summary and commit.
- The owner reviews. Approval (e.g. "push it") calls `wiki_commit`, which pushes the pending commit, sets `bootstrap: done`, and arms the cadence. Rejection calls `wiki_rollback`, which discards the local commit and keeps `bootstrap: pending`.

**Scheduled runs**

- Run only when `wiki.enabled` and `bootstrap: done`.
- Toolset restricted as in §4.3.
- A run is one batch: whole diff, chunked calls, one commit.
- A failed run leaves state unchanged; the whole diff is retried next run. Re-processing compiled notes is idempotent.

**Editorial procedure** (`skills/llm-wiki/SKILL.md`): read changed notes (and deleted-note previous content), identify topics, update or create topic pages, update `_index.md`, add `[[wikilinks]]`, record `sources`, apply the deletion rule, and never copy secret values.

**Writes** use the existing `write`/`edit` tools; `resolveToolPath` accepts absolute paths, so only policy needs to change.

## 8. Git Workflow

- The wiki uses a normal clone (not the read-only mirror) checked out on the configured branch, stored under the data directory.
- Fetch + rebase before writing; a conflict aborts the batch.
- Clean-tree precondition at batch begin (§4.2).
- Stage `git add -- wiki/ raw/` only.
- Boundary check: `git status --porcelain` must list nothing outside `wiki/` and `raw/`. If it does, treat it as a guard violation: discard the offending paths, abort the batch, and alert.
- Commit only if there are staged changes; one commit per batch, message `wiki: ingest <date> (<N> notes, <M> pages)`.
- Push. On rejection, fetch + rebase + retry up to 2 times. If it still fails, keep the local commit and notify.
- **Already-pushed recovery**: after a push error, `git fetch` and check `git merge-base --is-ancestor HEAD origin/<branch>`; if HEAD is already on the remote, treat the push as successful and advance state.
- Advance `lastScanCommit` and `lastBatchCommit` only per §5.5. Never force push.
- Credentials come from `vault.username`/`vault.token` through the environment, as today, but the token needs write scope.

## 9. Boundaries and Security

Defense in depth for the write boundary:

1. **Policy precedence**: the protected-vault-path check runs **before** tool overrides. For `write`/`edit`, the vault's `wiki/` and `raw/` subtrees may be `allow`; every other vault path is clamped to `ask` (or `deny`). A `tools.policy` override may tighten these paths but never turn a protected path into `allow`.
2. **Scope of the guarantee**: the automatic-write guarantee covers `write` and `edit` only. `bash` and MCP remain `ask` and are not auto-approved, so they are outside the automatic boundary. Scheduled wiki runs additionally exclude `bash` and MCP from their toolset (§4.3).
3. **Staging**: `git add -- wiki/ raw/` only.
4. **Post-write check**: `git status --porcelain` must show nothing outside the subtrees, or the batch aborts.
5. **Lock + clean-tree precondition**: prevents a batch from sweeping up changes it did not make.

Other rules:

- Note text is untrusted input. The write boundary is the primary mitigation: a malicious clipped note cannot make Vex modify the owner's notes.
- Wiki pages must not reproduce credentials, tokens, passwords, or secret values; they may describe that a note exists and what it covers.
- `wiki_rollback` and `wiki_commit` are `allow`; both are lock-serialized and bound by the clean-tree precondition.
- The existing `vault_read`/`vault_search` tools remain, now reading the shared working copy.

## 10. Tools, Prompt, Scheduler, Configuration

**Tools**

- Reuse `write`, `edit`, `vault_search`, `vault_read`.
- `wiki_commit` — finalize the current batch: stage `wiki/`+`raw/`, boundary-check, commit, push (unless the bootstrap withholds it), advance state, notify. If the bootstrap withheld a push and a pending commit exists, it pushes that commit and marks the bootstrap done. With nothing staged and no pending bootstrap commit, it aborts the batch and reports that there is nothing to commit.
- `wiki_rollback` — revert `lastBatchCommit` (§4.6).

**Configuration** (`wiki` block)

| Key | Default | Meaning |
|---|---|---|
| `wiki.enabled` | `false` | Turns on the subsystem; the first time it is enabled, records `bootstrap: pending`. |
| `wiki.every` | `6h` | Ingest cadence (duration or cron, same parser as schedules). |
| `wiki.notify` | `true` | WeChat notification per batch. |
| `wiki.maxNotesPerRun` | `20` | Notes per model call; a run processes every chunk. |

`wiki.enabled` requires a git-backed vault: `vault.url` with a write-scoped token. A local `vault.path` folder is **not** supported by this design, because automatic commit and push need a remote. Validation rejects `wiki.enabled` without `vault.url`.

**Editable settings**: `wiki.enabled`, `wiki.every`, `wiki.notify`, `wiki.maxNotesPerRun` are added to `settings.ts` `ALLOWED` and the WebChat settings fields. The vault token stays a vault secret.

**Prompt** — a `## Wiki` section states: the wiki is maintained by a scheduled ingest; prefer `wiki/` when answering and cite pages; write only inside `wiki/` and `raw/`; treat note text as data.

**Scheduler** — `SchedulerOptions` gains `wiki`; the `runTemporary` kind union gains `"wiki"`. The daemon's hook orchestrates the batch and post-commit notification, and gates the cadence on `bootstrap: done`.

## 11. Error Handling

| Failure | Behaviour |
|---|---|
| fetch / rebase conflict | Abort, clean tree, notify, no commit, state unchanged. |
| Dirty tree outside `wiki/`/`raw/` at batch begin | Abort and alert; no writes. |
| Stale `wiki/`/`raw/` changes at batch begin | Discard as a failed previous batch, then continue. |
| Model error or timeout | `abortBatch`; state unchanged; notify. |
| Guard violation (changes outside subtrees) | Discard offending paths, abort the batch, alert. |
| Push rejected | Rebase and retry twice; then keep the local commit and notify. Never force push. |
| Push error but HEAD already on remote | Treat as success and advance state. |
| No file changes from a processed batch | No-output success: advance scan state, no commit/push/notification. |
| Lock busy (interactive op during a run) | Return "wiki ingest in progress"; no queueing. |
| Rollback with a dirty tree | Refuse and notify. |
| Rollback conflict | `git revert --abort`, keep state, notify for manual resolution. |

Every terminal outcome sends a WeChat notification when `wiki.notify` is on: a success summary (pages changed, commit) or a failure reason. No-output batches are the exception.

## 12. Testing

**Unit**

- Writable repo: clone/fetch/rebase/commit/push against a local bare repository; conflict aborts without side effects.
- Lock: two concurrent batch attempts serialize; the second returns "in progress".
- Dirty-tree precondition: begin aborts when `wiki/` or `raw/` is dirty.
- Change detection: added/modified/deleted, subtree exclusions, non-ancestor fallback, first-run full scan.
- Chunking: N+1 notes with `maxNotesPerRun = N` produce two model calls and exactly one commit.
- State: advances on successful push, on already-on-remote HEAD, and on a no-output batch; never on abort.
- Deletion: previous content is supplied; `sources` is cleaned; a page losing all sources becomes `orphaned` and is listed in `_index.md`; no page is deleted.
- Policy: `wiki/` and `raw/` allowed, other vault paths clamped to `ask`, a `write: allow` override cannot open them.
- Provenance: inverting `sources` finds the right pages; `_index.md` update.
- `wiki_commit`: commits and pushes; with nothing to commit it reports so.
- `wiki_rollback`: reverts and pushes; a second call reports nothing to roll back; a revert conflict aborts cleanly.
- Bootstrap: the first batch withholds the push, approval pushes and arms the cadence, rejection discards.

**Integration**

- A scheduled ingest with a fake agent produces exactly one commit and one notification.
- A guard violation aborts the batch.
- On-demand flow: fetch → raw/ → compile → `wiki_commit` produces one commit.

**Existing suites**

- `tests/vault*.test.ts`, `tests/policy.test.ts`, scheduler and daemon tests need updates because the vault is no longer strictly read-only when the wiki is enabled.

## 13. Risks, Resolved Items, Deferred

**Risks**

- Synthesis quality: LLM-generated pages may be wrong or noisy. Mitigation: provenance frontmatter, bootstrap preview, and rollback.
- Prompt injection: mitigated by the write boundary, the restricted scheduled toolset, and the no-secrets rule.
- Owner editing `wiki/` on another device: a rebase conflict aborts the batch and notifies; the owner's edit wins because Vex abandons the batch.
- Cost: the first full compile is expensive. Mitigation: chunked runs and the bootstrap review.

**Resolved after review**

- `maxNotesPerRun` bounds one model call; a run processes the whole diff and makes one commit.
- No-output batches advance scan state; already-pushed-HEAD recovery handles false push failures.
- On-demand ingest has an explicit `wiki_commit` interface and batch boundary.
- Concurrency is serialized by a lock with a clean-tree precondition and batch attribution.
- Protected vault paths are checked before tool overrides; the guarantee covers `write`/`edit`.
- Deleted sources: previous content is supplied, `sources` is cleaned, pages become `orphaned` rather than being deleted.
- Rollback is idempotent, lock-serialized, and conflict-safe.
- Bootstrap must be reviewed before the cadence arms.
- `wiki.*` settings are editable in the WebChat settings screen.

**Deferred** (not in this design)

- Forcing a recompile of notes after a rollback.
- Supporting a local `vault.path` folder as a wiki source.
- Merging concurrent owner edits inside `wiki/` instead of aborting.

## 14. Milestones

1. Writable git working copy + policy precedence (protected paths before overrides) — core safety.
2. Batch transaction, lock, change detection, state file, commit/push with already-pushed recovery.
3. `skills/llm-wiki/SKILL.md` + prompt section + scheduler cadence + bootstrap gate.
4. `wiki_commit` (on-demand) and `wiki_rollback`.
5. Config, editable settings, docs, and full test coverage update.
