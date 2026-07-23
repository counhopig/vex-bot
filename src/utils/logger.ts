/**
 * Logger utility — pino-based structured logging.
 *
 * Minimal port from the archive. Defaults to stderr JSON output at info level.
 * The pino logger is wrapped so that callers get a child logger for their
 * module name via a simple `getChildLogger("module-name")` call.
 */

import pino from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";

let rootLogger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (!rootLogger) {
    rootLogger = pino({
      level: "info",
      name: "vex",
    });
  }
  return rootLogger;
}

export function setLogger(logger: pino.Logger): void {
  rootLogger = logger;
}

/** Get a namespaced child logger. See AGENTS.md "Logger via pino" convention. */
export function getChildLogger(name: string): pino.Logger {
  return getLogger().child({ module: name });
}

export type { pino as Logger };
