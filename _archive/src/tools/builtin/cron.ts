/**
 * Cron job tools
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CronService } from "../../cron/service.js";
import type { CronSchedule, CronJobCreate, CronPayload } from "../../cron/types.js";
import { TIME_CONSTANTS } from "../../cron/types.js";
import { formatSchedule, validateCronExpr } from "../../cron/schedule.js";

export interface CronToolsOptions { service: CronService; }

export function createCronTools(options: CronToolsOptions): AgentTool[] {
  const { service } = options;
  return [createCronListTool(service), createCronAddTool(service), createCronRemoveTool(service), createCronRunTool(service), createCronUpdateTool(service)];
}

function createCronListTool(service: CronService): AgentTool {
  return {
    name: "cron_list",
    label: "List Cron Jobs",
    description: "List all cron jobs",
    parameters: Type.Object({ includeDisabled: Type.Optional(Type.Boolean({ description: "Include disabled jobs" })) }),
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const { includeDisabled = false } = args as { includeDisabled?: boolean };
      const jobs = includeDisabled ? service.list({ includeDisabled: true }) : service.list();
      if (jobs.length === 0) return { content: [{ type: "text", text: "No cron jobs" }], details: {} };
      const lines = jobs.map(job => `${job.enabled ? "✅" : "❌"} **${job.name}** (ID: ${job.id})\n   Schedule: ${formatSchedule(job.schedule)}\n   Next run: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString("en-US") : "None"}`);
      return { content: [{ type: "text", text: `Cron job list (${jobs.length} total):\n\n${lines.join("\n\n")}` }], details: { count: jobs.length } };
    },
  };
}

function createCronAddTool(service: CronService): AgentTool {
  return {
    name: "cron_add",
    label: "Add Cron Job",
    description: "Add a cron job. Supports at/every/cron schedule types.",
    parameters: Type.Object({
      name: Type.String({ description: "Job name" }),
      scheduleType: Type.Union([Type.Literal("at"), Type.Literal("every"), Type.Literal("cron")], { description: "Schedule type" }),
      atTime: Type.Optional(Type.String({ description: "One-time job execution time (ISO 8601)" })),
      everyMs: Type.Optional(Type.Number({ description: "Periodic job interval (ms)" })),
      everyUnit: Type.Optional(Type.Union([Type.Literal("seconds"), Type.Literal("minutes"), Type.Literal("hours"), Type.Literal("days")], { description: "Time unit" })),
      everyValue: Type.Optional(Type.Number({ description: "Time value" })),
      cronExpr: Type.Optional(Type.String({ description: "Cron expression" })),
      cronTz: Type.Optional(Type.String({ description: "Timezone" })),
      message: Type.String({ description: "Job message content" }),
      payloadType: Type.Optional(Type.Union([Type.Literal("systemEvent"), Type.Literal("agentTurn")], { description: "Job type" })),
      deliver: Type.Optional(Type.Boolean({ description: "Deliver result to channel" })),
      channel: Type.Optional(Type.String({ description: "Delivery channel" })),
      to: Type.Optional(Type.String({ description: "Delivery target ID" })),
      model: Type.Optional(Type.String({ description: "Specify model" })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Timeout (seconds)" })),
    }),
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const { name, scheduleType, atTime, everyMs, everyUnit, everyValue, cronExpr, cronTz, message, payloadType = "systemEvent", deliver, channel, to, model, timeoutSeconds } = args as any;

      // Validate agentTurn parameters
      if (payloadType === "agentTurn") {
        if (deliver && channel) {
          const validChannels = ["weixin", "webchat"];
          if (!validChannels.includes(channel)) {
            return { content: [{ type: "text", text: `Error: invalid channel "${channel}", valid channels: ${validChannels.join(", ")}` }], details: { error: "invalid_channel" } };
          }
        }
        if (timeoutSeconds !== undefined && (timeoutSeconds < 1 || timeoutSeconds > 600)) {
          return { content: [{ type: "text", text: `Error: timeoutSeconds must be between 1 and 600 seconds` }], details: { error: "invalid_timeout" } };
        }
      }

      let schedule: CronSchedule;
      if (scheduleType === "at") {
        if (!atTime) return { content: [{ type: "text", text: "Error: atTime parameter is required" }], details: { error: "missing_atTime" } };
        const atMs = new Date(atTime).getTime();
        if (isNaN(atMs)) return { content: [{ type: "text", text: "Error: invalid atTime format" }], details: { error: "invalid_atTime" } };
        schedule = { kind: "at", atMs };
      } else if (scheduleType === "every") {
        let intervalMs = everyMs;
        if (!intervalMs && everyUnit && everyValue) {
          const unitMap: Record<string, number> = { seconds: TIME_CONSTANTS.SECOND, minutes: TIME_CONSTANTS.MINUTE, hours: TIME_CONSTANTS.HOUR, days: TIME_CONSTANTS.DAY };
          intervalMs = everyValue * unitMap[everyUnit]!;
        }
        if (!intervalMs || intervalMs <= 0) return { content: [{ type: "text", text: "Error: need a valid interval" }], details: { error: "invalid_interval" } };
        schedule = { kind: "every", everyMs: intervalMs };
      } else {
        if (!cronExpr) return { content: [{ type: "text", text: "Error: cronExpr parameter is required" }], details: { error: "missing_cronExpr" } };
        const validation = validateCronExpr(cronExpr);
        if (!validation.valid) return { content: [{ type: "text", text: `Error: invalid cron expression - ${validation.error}` }], details: { error: "invalid_cron" } };
        schedule = { kind: "cron", expr: cronExpr, tz: cronTz };
      }

      let payload: CronPayload;
      let typeDesc: string;
      if (payloadType === "agentTurn") {
        payload = { kind: "agentTurn", message, model, timeoutSeconds, deliver, channel, to };
        typeDesc = "Agent execution";
        if (deliver && channel) {
          typeDesc += ` → deliver to ${channel}:${to}`;
        }
      } else {
        payload = { kind: "systemEvent", message };
        typeDesc = "System event";
      }

      let job;
      try {
        job = service.add({ name, schedule, payload } as CronJobCreate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: "add_failed" } };
      }
      return { content: [{ type: "text", text: `Cron job created:\n- ID: ${job.id}\n- Name: ${job.name}\n- Type: ${typeDesc}\n- Schedule: ${formatSchedule(job.schedule)}` }], details: { jobId: job.id } };
    },
  };
}

function createCronRemoveTool(service: CronService): AgentTool {
  return {
    name: "cron_remove",
    label: "Remove Cron Job",
    description: "Remove a cron job by ID",
    parameters: Type.Object({ jobId: Type.String({ description: "Job ID" }) }),
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const { jobId } = args as { jobId: string };
      const job = service.get(jobId);
      if (!job) return { content: [{ type: "text", text: `Error: job not found ${jobId}` }], details: { error: "not_found" } };
      const removed = service.remove(jobId);
      if (!removed) return { content: [{ type: "text", text: "Error: removal failed" }], details: { error: "remove_failed" } };
      return { content: [{ type: "text", text: `Cron job removed: ${job.name} (ID: ${jobId})` }], details: {} };
    },
  };
}

function createCronRunTool(service: CronService): AgentTool {
  return {
    name: "cron_run",
    label: "Run Job Now",
    description: "Immediately execute a cron job",
    parameters: Type.Object({ jobId: Type.String({ description: "Job ID" }) }),
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const { jobId } = args as { jobId: string };
      const result = await service.run(jobId);
      if (result.status === "ok") return { content: [{ type: "text", text: "Job executed successfully" }], details: {} };
      if (result.status === "not_found") return { content: [{ type: "text", text: `Error: job not found ${jobId}` }], details: { error: "not_found" } };
      return { content: [{ type: "text", text: `Job execution failed: ${result.error}` }], details: { error: result.error } };
    },
  };
}

function createCronUpdateTool(service: CronService): AgentTool {
  return {
    name: "cron_update",
    label: "Update Cron Job",
    description: "Update a cron job's name or enabled status",
    parameters: Type.Object({
      jobId: Type.String({ description: "Job ID" }),
      name: Type.Optional(Type.String({ description: "New name" })),
      enabled: Type.Optional(Type.Boolean({ description: "Whether enabled" })),
    }),
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const { jobId, name, enabled } = args as { jobId: string; name?: string; enabled?: boolean };
      const updates: { name?: string; enabled?: boolean } = {};
      if (name !== undefined) updates.name = name;
      if (enabled !== undefined) updates.enabled = enabled;
      if (Object.keys(updates).length === 0) return { content: [{ type: "text", text: "Error: no fields to update" }], details: { error: "no_updates" } };
      const job = service.update(jobId, updates);
      if (!job) return { content: [{ type: "text", text: `Error: job not found ${jobId}` }], details: { error: "not_found" } };
      return { content: [{ type: "text", text: `Cron job updated:\n- ID: ${job.id}\n- Name: ${job.name}\n- Status: ${job.enabled ? "Enabled" : "Disabled"}` }], details: {} };
    },
  };
}