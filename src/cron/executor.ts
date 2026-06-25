/**
 * Cron job executor
 *
 * Handles cron job execution including Agent calls and message delivery
 */

import type { CronJob, PayloadAgentTurn } from "./types.js";
import type { ChannelId } from "../types/index.js";
import { deliverOutboundPayloads, isChannelAvailable } from "../outbound/index.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("cron-executor");

/** Job execution result */
export interface CronExecutionResult {
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  /** Agent output text */
  outputText?: string;
}

/** Agent executor function type */
export type AgentExecutor = (params: {
  message: string;
  sessionKey?: string;
  model?: string;
  timeoutSeconds?: number;
}) => Promise<{
  success: boolean;
  output: string;
  error?: string;
}>;

/** Cron executor options */
export interface CronExecutorOptions {
  /** Agent executor function (optional, for agentTurn jobs) */
  agentExecutor?: AgentExecutor;
  /** Default channel (for delivery) */
  defaultChannel?: ChannelId;
}

/**
 * Create Cron job executor
 */
export function createCronExecutor(options?: CronExecutorOptions) {
  const { agentExecutor, defaultChannel } = options ?? {};

  /**
   * Execute single job
   */
  async function executeJob(job: CronJob): Promise<CronExecutionResult> {
    const { payload } = job;

    logger.info({ jobId: job.id, jobName: job.name, payloadKind: payload.kind }, "Executing cron job");

    try {
      switch (payload.kind) {
        case "systemEvent":
          return executeSystemEvent(job);

        case "agentTurn":
          return executeAgentTurn(job, payload);

        default:
          return {
            status: "error",
            error: `Unknown payload kind: ${(payload as { kind: string }).kind}`,
          };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ jobId: job.id, error }, "Cron job execution failed");
      return { status: "error", error };
    }
  }

  /**
   * Execute system event job
   */
  async function executeSystemEvent(job: CronJob): Promise<CronExecutionResult> {
    // systemEvent just logs, no action needed
    logger.info(
      { jobId: job.id, message: job.payload.kind === "systemEvent" ? job.payload.message : "" },
      "System event triggered"
    );
    return { status: "ok", summary: "System event executed" };
  }

  /**
   * Execute Agent turn job
   */
  async function executeAgentTurn(
    job: CronJob,
    payload: PayloadAgentTurn
  ): Promise<CronExecutionResult> {
    const { message, model, timeoutSeconds, deliver, channel, to } = payload;

    // If no agentExecutor, just log
    if (!agentExecutor) {
      logger.warn({ jobId: job.id }, "No agent executor configured, skipping agentTurn execution");
      return {
        status: "skipped",
        summary: "No agent executor configured",
      };
    }

    // Execute Agent
    logger.info({ jobId: job.id, message: message.slice(0, 100) }, "Executing agent turn");

    let agentResult: Awaited<ReturnType<AgentExecutor>>;
    try {
      agentResult = await agentExecutor({
        message,
        sessionKey: `cron:${job.id}`,
        model,
        timeoutSeconds,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ jobId: job.id, error }, "Agent executor threw exception");
      return {
        status: "error",
        error,
      };
    }

    if (!agentResult.success) {
      return {
        status: "error",
        error: agentResult.error ?? "Agent execution failed",
        outputText: agentResult.output,
      };
    }

    const outputText = agentResult.output;

    // If delivery needed
    if (deliver && to) {
      await deliverAgentOutput(job, payload, outputText);
    }

    return {
      status: "ok",
      summary: outputText.slice(0, 200),
      outputText,
    };
  }

  /**
   * Deliver Agent output
   */
  async function deliverAgentOutput(
    job: CronJob,
    payload: PayloadAgentTurn,
    outputText: string
  ): Promise<void> {
    const { channel: targetChannel, to } = payload;

    if (!to) {
      logger.warn({ jobId: job.id }, "No delivery target specified");
      return;
    }

    // Parse channel
    const channelId = resolveChannel(targetChannel);
    if (!channelId) {
      logger.warn({ jobId: job.id, targetChannel }, "Invalid or unavailable channel");
      return;
    }

    // Check if channel is available
    if (!isChannelAvailable(channelId)) {
      logger.warn({ jobId: job.id, channelId }, "Channel not available");
      return;
    }

    // Deliver message
    logger.info({ jobId: job.id, channelId, to }, "Delivering agent output");

    try {
      const results = await deliverOutboundPayloads({
        channel: channelId,
        to,
        payloads: [{ text: outputText }],
        bestEffort: true,
      });

      const successCount = results.filter((r) => r.success).length;
      logger.info(
        { jobId: job.id, channelId, to, successCount, totalCount: results.length },
        "Delivery completed"
      );
    } catch (err) {
      logger.error({ jobId: job.id, error: err }, "Delivery failed");
    }
  }

  /**
   * Parse channel ID
   */
  function resolveChannel(channel?: string): ChannelId | null {
    if (!channel || channel === "last") {
      // "last" means use default or previously used channel
      return defaultChannel ?? null;
    }

    // Validate channel ID
    const validChannels: ChannelId[] = ["weixin", "webchat"];
    if (validChannels.includes(channel as ChannelId)) {
      return channel as ChannelId;
    }

    return null;
  }

  return {
    executeJob,
    executeSystemEvent,
    executeAgentTurn,
  };
}

/**
 * Create default Cron job execution function
 * Used as executeJob parameter for getCronService
 */
export function createDefaultCronExecuteJob(options?: CronExecutorOptions) {
  const executor = createCronExecutor(options);
  return executor.executeJob;
}
