/**
 * Cron job executor — systemEvent is a no-op, agentTurn dispatches
 * via the injected dispatcher.
 *
 * Cron never imports Agent/AgentRegistry directly. The dependency goes
 * one way only: the bootstrap layer injects a `dispatch` callback
 * bound to `Dispatcher.dispatchSynthetic()`, and cron calls it with
 * a synthesized `InboundMessageContext` whose `webUserId` is the
 * job's `ownerId`.
 */

import { getChildLogger } from "../utils/logger.js";
import type { CronExecutionResult, CronJob, PayloadAgentTurn } from "./types.js";
import type { InboundMessageContext } from "../channels/ChannelAdapter.js";

const logger = getChildLogger("cron-executor");

export interface CronDispatcher {
  /**
   * Dispatch a synthetic inbound message. Caller wraps
   * `Dispatcher.dispatchSynthetic()` or a stub for tests.
   */
  dispatch(ctx: InboundMessageContext): Promise<unknown>;
}

export interface CronExecutorOptions {
  /** Injected by bootstrap — bound to Dispatcher.dispatchSynthetic(). */
  dispatch: CronDispatcher["dispatch"];
}

/**
 * Create a Cron job executor. Returns an object with `executeJob`.
 */
export function createCronExecutor(options: CronExecutorOptions): {
  executeJob(job: CronJob): Promise<CronExecutionResult>;
} {
  const { dispatch } = options;

  async function executeJob(job: CronJob): Promise<CronExecutionResult> {
    const { payload } = job;
    logger.info(
      { jobId: job.id, jobName: job.name, ownerId: job.ownerId, payloadKind: payload.kind },
      "Executing cron job",
    );
    try {
      switch (payload.kind) {
        case "systemEvent":
          // systemEvent is just a log — no agent involvement.
          return {
            status: "ok",
            summary: `System event: ${payload.message.slice(0, 200)}`,
          };

        case "agentTurn":
          return await executeAgentTurn(job, payload, dispatch);

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

  return { executeJob };
}

async function executeAgentTurn(
  job: CronJob,
  payload: PayloadAgentTurn,
  dispatch: CronDispatcher["dispatch"],
): Promise<CronExecutionResult> {
  // Build the synthetic InboundMessageContext that routes to the right
  // Agent via the Dispatcher. ownerId is the per-tenant key; if absent,
  // Dispatcher.resolveUserId() falls back to senderId ("cron-system").
  // We use "webchat" as the channel because cron is an internal trigger
  // — there is no real "cron" channel in the type, and webchat's
  // ChannelRegistry path is the closest match for non-channel triggers.
  const ctx: InboundMessageContext = {
    channelId: "webchat",
    messageId: `cron-${job.id}-${Date.now()}`,
    chatId: `cron:${job.id}`,
    chatType: "direct",
    senderId: "cron-system",
    content: payload.message,
    timestamp: Date.now(),
    ...(job.ownerId !== undefined ? { webUserId: job.ownerId } : {}),
  };

  await dispatch(ctx);

  return {
    status: "ok",
    summary: payload.message.slice(0, 200),
  };
}