/**
 * Logger tests — getChildLogger must reflect whatever root logger is active
 * at *log-call* time, not whichever root logger happened to exist when the
 * child logger was created.
 *
 * This matters because nearly every module does `const logger =
 * getChildLogger("x")` at module top-level (import time), which runs before
 * cli/server.ts's `setLogger(createLogger({level: config.logging.level}))`
 * (called at `start` command execution time, after all imports resolve). If
 * getChildLogger bound eagerly to the root logger active at import time, the
 * configured log level/format would never reach any module-scope logger.
 */

import { describe, expect, it } from "vitest";
import { createLogger, getChildLogger, setLogger } from "../src/utils/logger.js";

describe("getChildLogger", () => {
  it("reflects a setLogger() call made after the child logger was created", () => {
    setLogger(createLogger({ level: "info", pretty: false, logToFile: false }));
    const child = getChildLogger("pretest");
    expect(child.level).toBe("info");

    setLogger(createLogger({ level: "debug", pretty: false, logToFile: false }));
    expect(child.level).toBe("debug");
  });

  it("still tags log lines with the module name after a later setLogger() call", () => {
    setLogger(createLogger({ level: "info", pretty: false, logToFile: false }));
    const child = getChildLogger("my-module");
    setLogger(createLogger({ level: "debug", pretty: false, logToFile: false }));
    // bindings are exposed on the pino logger instance for child loggers.
    expect((child as unknown as { bindings(): Record<string, unknown> }).bindings()).toMatchObject({
      module: "my-module",
    });
  });
});
