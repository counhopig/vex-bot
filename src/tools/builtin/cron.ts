/**
 * Built-in tools — Cron scheduling (list / add / remove / run / update).
 *
 * Ported from _archive/src/tools/builtin/cron.ts. Key changes:
 *   - Uses Tool type from ../types.js (not AgentTool from pi-agent-core).
 *   - CronService imported as type-only (the module may not exist yet).
 *   - When service is undefined, tools use a simplified disabled path.
 *   - 5-param execute (match ToolDefinition, last 3 prefixed with _).
 */

import { Type, type Static } from "@sinclair/typebox";
import type { Tool } from "../types.js";
import { jsonResult, errorResult } from "../common.js";
import type { CronJob, CronJobCreate, CronSchedule } from "../../cron/types.js";
import type { CronService } from "../../cron/service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `At ${schedule.atMs ? new Date(schedule.atMs).toISOString() : "?"}`;
    case "every":
      return `Every ${(schedule.everyMs ?? 0) / 1000}s`;
    case "cron":
      return `Cron "${schedule.expr ?? ""}"`;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CronToolsOptions {
  /** Per-runtime CronService instance. When undefined, tools return disabled. */
  service?: CronService;
}

// ---------------------------------------------------------------------------
// cron_list
// ---------------------------------------------------------------------------

function createCronListTool(service?: CronService): Tool {
  const parameters = Type.Object({
    includeDisabled: Type.Optional(
      Type.Boolean({ description: "Include disabled jobs" }),
    ),
  });

  return {
    name: "cron_list",
    label: "List Cron Jobs",
    description: "List all cron jobs.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      if (!service) {
        return jsonResult({
          status: "disabled",
          message: "Cron system not enabled",
        });
      }
      const params = args as Static<typeof parameters>;
      const includeDisabled = params.includeDisabled ?? false;
      const jobs = includeDisabled
        ? service.list({ includeDisabled: true })
        : service.list();
      if (jobs.length === 0) {
        return jsonResult({ status: "success", count: 0, jobs: [] });
      }
      return jsonResult({
        status: "success",
        count: jobs.length,
        jobs: jobs.map((job) => ({
          id: job.id,
          name: job.name,
          enabled: job.enabled,
          schedule: formatSchedule(job.schedule),
          nextRunAt: job.state.nextRunAtMs,
        })),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// cron_add
// ---------------------------------------------------------------------------

function createCronAddTool(service?: CronService): Tool {
  const parameters = Type.Object({
    name: Type.String({ description: "Job name" }),
    scheduleType: Type.Union(
      [Type.Literal("at"), Type.Literal("every"), Type.Literal("cron")],
      { description: "Schedule type" },
    ),
    atTime: Type.Optional(
      Type.String({ description: "One-time job execution time (ISO 8601)" }),
    ),
    everyMs: Type.Optional(
      Type.Number({ description: "Periodic job interval (ms)" }),
    ),
    everyUnit: Type.Optional(
      Type.Union([
        Type.Literal("seconds"),
        Type.Literal("minutes"),
        Type.Literal("hours"),
        Type.Literal("days"),
      ]),
    ),
    everyValue: Type.Optional(
      Type.Number({ description: "Time value" }),
    ),
    cronExpr: Type.Optional(
      Type.String({ description: "Cron expression" }),
    ),
    cronTz: Type.Optional(
      Type.String({ description: "Timezone" }),
    ),
    message: Type.String({ description: "Job message content" }),
    payloadType: Type.Optional(
      Type.Union(
        [Type.Literal("systemEvent"), Type.Literal("agentTurn")],
        { description: "Job type" },
      ),
    ),
    deliver: Type.Optional(
      Type.Boolean({ description: "Deliver result to channel" }),
    ),
    channel: Type.Optional(
      Type.String({ description: "Delivery channel" }),
    ),
    to: Type.Optional(
      Type.String({ description: "Delivery target ID" }),
    ),
    model: Type.Optional(
      Type.String({ description: "Specify model" }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({ description: "Timeout (seconds)" }),
    ),
  });

  return {
    name: "cron_add",
    label: "Add Cron Job",
    description:
      "Add a cron job. Supports at/every/cron schedule types.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      if (!service) {
        return jsonResult({
          status: "disabled",
          message: "Cron system not enabled",
        });
      }

      const params = args as Static<typeof parameters>;

      // Validate agentTurn parameters
      if (
        (params.payloadType ?? "systemEvent") === "agentTurn"
      ) {
        if (params.deliver && params.channel) {
          const validChannels = ["weixin", "webchat"];
          if (!validChannels.includes(params.channel)) {
            return errorResult(
              `Invalid channel "${params.channel}", valid: ${validChannels.join(", ")}`,
            );
          }
        }
        if (
          params.timeoutSeconds !== undefined &&
          (params.timeoutSeconds < 1 || params.timeoutSeconds > 600)
        ) {
          return errorResult(
            "timeoutSeconds must be between 1 and 600 seconds",
          );
        }
      }

      // Build schedule
      let schedule: CronSchedule;
      if (params.scheduleType === "at") {
        if (!params.atTime) {
          return errorResult("atTime parameter is required");
        }
        const atMs = new Date(params.atTime).getTime();
        if (isNaN(atMs)) {
          return errorResult("Invalid atTime format");
        }
        schedule = { kind: "at", atMs };
      } else if (params.scheduleType === "every") {
        let intervalMs = params.everyMs;
        if (!intervalMs && params.everyUnit && params.everyValue) {
          const unitMap: Record<string, number> = {
            seconds: 1000,
            minutes: 60 * 1000,
            hours: 3600 * 1000,
            days: 86400 * 1000,
          };
          intervalMs = params.everyValue * unitMap[params.everyUnit]!;
        }
        if (!intervalMs || intervalMs <= 0) {
          return errorResult("Need a valid interval");
        }
        schedule = { kind: "every", everyMs: intervalMs };
      } else {
        if (!params.cronExpr) {
          return errorResult("cronExpr parameter is required");
        }
        schedule = {
          kind: "cron",
          expr: params.cronExpr,
          tz: params.cronTz,
        };
      }

      // Build payload
      const payloadType = params.payloadType ?? "systemEvent";
      let payload: CronJobCreate["payload"];
      if (payloadType === "agentTurn") {
        payload = {
          kind: "agentTurn",
          message: params.message,
          model: params.model,
          timeoutSeconds: params.timeoutSeconds,
          deliver: params.deliver,
          channel: params.channel,
          to: params.to,
        };
      } else {
        payload = {
          kind: "systemEvent",
          message: params.message,
        };
      }

      try {
        const job = service.add({
          name: params.name,
          schedule,
          payload,
        } as CronJobCreate);
        return jsonResult({
          status: "success",
          jobId: job.id,
          name: job.name,
          schedule: formatSchedule(job.schedule),
        });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// cron_remove
// ---------------------------------------------------------------------------

function createCronRemoveTool(service?: CronService): Tool {
  const parameters = Type.Object({
    jobId: Type.String({ description: "Job ID" }),
  });

  return {
    name: "cron_remove",
    label: "Remove Cron Job",
    description: "Remove a cron job by ID.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      if (!service) {
        return jsonResult({
          status: "disabled",
          message: "Cron system not enabled",
        });
      }
      const params = args as Static<typeof parameters>;
      const jobId = params.jobId;
      const job = service.get(jobId);
      if (!job) {
        return errorResult(`Job not found: ${jobId}`);
      }
      const removed = service.remove(jobId);
      if (!removed) {
        return errorResult("Removal failed");
      }
      return jsonResult({
        status: "success",
        jobId,
        name: job.name,
        message: "Cron job removed",
      });
    },
  };
}

// ---------------------------------------------------------------------------
// cron_run
// ---------------------------------------------------------------------------

function createCronRunTool(service?: CronService): Tool {
  const parameters = Type.Object({
    jobId: Type.String({ description: "Job ID" }),
  });

  return {
    name: "cron_run",
    label: "Run Job Now",
    description: "Immediately execute a cron job.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      if (!service) {
        return jsonResult({
          status: "disabled",
          message: "Cron system not enabled",
        });
      }
      const params = args as Static<typeof parameters>;
      const jobId = params.jobId;
      const result = await service.run(jobId);
      if (result.status === "ok") {
        return jsonResult({ status: "success", message: "Job executed" });
      }
      if (result.status === "not_found") {
        return errorResult(`Job not found: ${jobId}`);
      }
      return errorResult(
        `Job execution failed: ${result.error ?? "unknown"}`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// cron_update
// ---------------------------------------------------------------------------

function createCronUpdateTool(service?: CronService): Tool {
  const parameters = Type.Object({
    jobId: Type.String({ description: "Job ID" }),
    name: Type.Optional(Type.String({ description: "New name" })),
    enabled: Type.Optional(
      Type.Boolean({ description: "Whether enabled" }),
    ),
  });

  return {
    name: "cron_update",
    label: "Update Cron Job",
    description: "Update a cron job's name or enabled status.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      if (!service) {
        return jsonResult({
          status: "disabled",
          message: "Cron system not enabled",
        });
      }
      const params = args as Static<typeof parameters>;
      const updates: { name?: string; enabled?: boolean } = {};
      if (params.name !== undefined) updates.name = params.name;
      if (params.enabled !== undefined)
        updates.enabled = params.enabled;
      if (Object.keys(updates).length === 0) {
        return errorResult("No fields to update");
      }
      const job = service.update(params.jobId, updates);
      if (!job) {
        return errorResult(`Job not found: ${params.jobId}`);
      }
      return jsonResult({
        status: "success",
        jobId: job.id,
        name: job.name,
        enabled: job.enabled,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Batch factory
// ---------------------------------------------------------------------------

export function createCronTools(options?: CronToolsOptions): Tool[] {
  const service = options?.service;
  return [
    createCronListTool(service),
    createCronAddTool(service),
    createCronRemoveTool(service),
    createCronRunTool(service),
    createCronUpdateTool(service),
  ];
}
