import type { Logger } from "./logger.js";

/** The order vexd releases its resources in, both when stopping and after a failed start. */
const ORDER = ["scheduler", "wechat", "device", "sessions", "approvals", "MCP", "persona", "gateway", "memory index", "wiki", "traces"] as const;
export type ShutdownStep = typeof ORDER[number];

/** Resources register as they come up; run releases the registered ones in ORDER, each step isolated from the others' failures. */
export class ShutdownPlan {
  private readonly steps = new Map<ShutdownStep, () => Promise<void> | void>();

  constructor(private readonly log: Logger) {}

  add(step: ShutdownStep, close: () => Promise<void> | void): void {
    this.steps.set(step, close);
  }

  async run(): Promise<void> {
    for (const step of ORDER) {
      const close = this.steps.get(step);
      if (!close) continue;
      try {
        await close();
      } catch (err) {
        this.log.error({ err, step }, "shutdown step failed");
      }
    }
  }
}
