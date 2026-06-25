# Cron Module

Scheduling engine: at/every/cron expressions. Two job types: agentTurn (AI conversation via callback) and systemEvent (signal via outbound delivery). Singleton CronService with JSON persistence at `~/.vex/cron/jobs.json`.

## STRUCTURE

```
cron/
├── types.ts       # CronJob, CronSchedule (discriminated: at/every/cron), CronPayload, CronEvent, TIME_CONSTANTS
├── service.ts     # CronService class: scheduling loop (setTimeout chaining), add/remove/run/update, singleton pattern
├── schedule.ts    # Schedule computation: computeJobNextRunAtMs for at/every/cron, isExpired, formatSchedule
├── executor.ts    # Job execution: agentTurn delegates to AgentExecutor callback, systemEvent sends outbound
├── store.ts       # JsonCronStore: load/save/atomic write + backup at ~/.vex/cron/jobs.json
└── index.ts       # Barrel re-export
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Start cron service | `service.ts` → `getCronService().start()` | Called inside `createAgent()`, before Gateway starts |
| Add a job | `service.ts` → `addJob(create: CronJobCreate)` | Validates schedule, computes nextRunAtMs, persists |
| Compute next run | `schedule.ts` → `computeJobNextRunAtMs()` | Dispatches by schedule kind; Cron uses custom 5/6-field parser |
| Execute a job | `executor.ts` → `createCronExecutor()` | Returns `executeJob(job): Promise<CronExecutionResult>` |
| Agent callback wiring | `executor.ts` → `AgentExecutor` type | `(message, sessionKey?, model?, timeoutSeconds?) => Promise<{success, output}>` |
| Outbound delivery | `executor.ts` → `executeSystemEvent()` | Calls `deliverOutboundPayloads` from `outbound/index.ts` |
| Job persistence | `store.ts` → `JsonCronStore` | `save()` writes to temp file then renames (atomic), backs up old as `.bak` |
| Define a new schedule type | `types.ts` → `CronSchedule` union | Add variant, then handle in `schedule.ts` and `executor.ts` |
| Cron tools integration | `tools/builtin/cron.ts` | 5 tools (list/add/remove/run/update) all delegate to `CronService` |

## SCHEDULE TYPES

| Kind | Field | Example |
|------|-------|---------|
| `at` | `atMs: number` | One-shot at absolute timestamp |
| `every` | `everyMs: number`, `anchorMs?: number` | Periodic, aligned to anchor |
| `cron` | `expr: string`, `tz?: string` | Standard 5-field or 6-field (seconds) expression |

## KEY PATTERNS

- **Singleton**: `getCronService(deps?)` returns module-level singleton; `resetCronService()` for tests
- **Clock injection**: `CronServiceDeps.nowMs: () => number` for deterministic testing
- **Timeout chaining**: Uses `setTimeout` (not `setInterval`), re-arms after each run, capped at `MAX_TIMEOUT_MS`
- **Stuck detection**: Jobs running > `STUCK_RUN_MS` (2 hours) are marked as skipped on restart
- **AgentExecutor callback**: Set via `createCronExecutor({ agentExecutor })`, wired by `createAgent()` using the Agent runtime

## ANTI-PATTERNS

- **NEVER** duplicate scheduling logic, the 5 cron tools delegate to `CronService`
- **NEVER** call `cronService.start()` before all jobs are loaded (happens in `createAgent()`)
- **NEVER** use `setInterval` for the scheduling loop, it is `setTimeout` re-arming
- **NEVER** access `this.store` directly from outside `CronService`, use `addJob`/`removeJob`/`updateJob` methods
